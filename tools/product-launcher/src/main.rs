//! Product lifecycle launcher. The server receives the bootstrap token over its
//! private stdin pipe; the token is never an argument, environment value, or log value.

use std::{
    env, fs,
    io::{self, BufRead, BufReader, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

const TOKEN_BYTES: usize = 32;
const READY_TIMEOUT: Duration = Duration::from_secs(15);

fn hex_token(bytes: [u8; TOKEN_BYTES]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    token
}

#[cfg(windows)]
fn random_token() -> io::Result<String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut core::ffi::c_void,
            buffer: *mut u8,
            buffer_len: u32,
            flags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let mut bytes = [0_u8; TOKEN_BYTES];
    let status = unsafe {
        BCryptGenRandom(
            core::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::other("Windows cryptographic RNG failed"));
    }
    Ok(hex_token(bytes))
}

#[cfg(not(windows))]
fn random_token() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "product-launcher is supported only on Windows",
    ))
}

fn choose_loopback_port() -> io::Result<u16> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn validate_bundled_path(
    bundle_root: &Path,
    supplied: &Path,
    extension: &str,
) -> io::Result<PathBuf> {
    if !supplied.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bundled path must be absolute",
        ));
    }
    let canonical = fs::canonicalize(supplied)?;
    if !canonical.is_file()
        || canonical.extension().and_then(|part| part.to_str()) != Some(extension)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bundled path has an invalid file type",
        ));
    }
    if !canonical.starts_with(bundle_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "bundled path escapes bundle root",
        ));
    }
    Ok(canonical)
}

fn bootstrap_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/#bootstrap={token}")
}

fn await_ready(stdout: impl io::Read + Send + 'static, token: String) -> io::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let line = receiver.recv_timeout(READY_TIMEOUT).map_err(|_| {
        io::Error::new(io::ErrorKind::TimedOut, "server did not signal readiness")
    })??;
    let expected = format!("READY {token}\n");
    if line != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid server readiness message",
        ));
    }
    Ok(())
}

struct ManagedChild {
    child: Child,
    finished: bool,
}

impl ManagedChild {
    fn terminate_tree(&mut self) {
        #[cfg(windows)]
        {
            // taskkill /T asks Windows to terminate descendants as well as Node.
            let _ = Command::new(
                PathBuf::from(env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
                    .join("System32")
                    .join("taskkill.exe"),
            )
            .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
            .status();
        }
        let _ = self.child.kill();
    }

    fn wait(&mut self) -> io::Result<()> {
        let status = self.child.wait()?;
        self.finished = true;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("bundled server exited unsuccessfully"))
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if !self.finished {
            self.terminate_tree();
        }
    }
}

#[cfg(windows)]
fn open_browser(url: &str) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let url: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        ShellExecuteW(
            0,
            core::ptr::null(),
            url.as_ptr(),
            core::ptr::null(),
            core::ptr::null(),
            1,
        )
    } <= 32
    {
        return Err(io::Error::other("could not open the default browser"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_browser(_: &str) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "product-launcher is supported only on Windows",
    ))
}

fn run() -> io::Result<()> {
    if !cfg!(windows) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "product-launcher is supported only on Windows",
        ));
    }
    let mut args = env::args_os().skip(1);
    let bundle_root = args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: product-launcher <bundle-root> <node.exe> <server.js>",
        )
    })?;
    let node = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing bundled node path"))?;
    let server = args.next().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing bundled server path")
    })?;
    if args.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unexpected argument",
        ));
    }

    let bundle_root = fs::canonicalize(bundle_root)?;
    let node = validate_bundled_path(&bundle_root, Path::new(&node), "exe")?;
    if node
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("node.exe"))
        != Some(true)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bundled executable must be node.exe",
        ));
    }
    let server = validate_bundled_path(&bundle_root, Path::new(&server), "js")?;
    let port = choose_loopback_port()?;
    let token = random_token()?;

    let child = Command::new(node)
        .arg(server)
        .arg("--loopback-port")
        .arg(port.to_string())
        .arg("--bootstrap-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut managed = ManagedChild {
        child,
        finished: false,
    };
    let mut stdin = managed
        .child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("bootstrap pipe unavailable"))?;
    stdin.write_all(format!("BOOTSTRAP {token}\n").as_bytes())?;
    stdin.flush()?;
    drop(stdin);
    let stdout = managed
        .child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("readiness pipe unavailable"))?;
    await_ready(stdout, token.clone())?;
    open_browser(&bootstrap_url(port, &token))?;
    managed.wait()
}

fn main() {
    if let Err(error) = run() {
        eprintln!("product-launcher: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_256_bits_as_lowercase_hex() {
        assert_eq!(hex_token([0xab; TOKEN_BYTES]), "ab".repeat(TOKEN_BYTES));
    }

    #[test]
    fn bootstrap_url_keeps_token_out_of_http_request_path() {
        let url = bootstrap_url(43123, "a1");
        assert_eq!(url, "http://127.0.0.1:43123/#bootstrap=a1");
    }

    #[test]
    fn loopback_port_is_nonzero() {
        assert_ne!(choose_loopback_port().unwrap(), 0);
    }
}
