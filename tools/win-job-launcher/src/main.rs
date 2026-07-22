use std::env;
use std::process::ExitCode;

const CANCEL_GRACE_MS: u32 = 2_000;

#[derive(Debug, PartialEq, Eq)]
struct Arguments {
    timeout_ms: u32,
    command: Vec<String>,
}

fn usage() -> &'static str {
    "usage: win-job-launcher --timeout-ms <positive milliseconds> -- <program> [argument ...]"
}

fn parse_arguments(arguments: impl IntoIterator<Item = String>) -> Result<Arguments, String> {
    let mut arguments = arguments.into_iter();
    let Some(flag) = arguments.next() else {
        return Err(usage().to_owned());
    };
    if flag != "--timeout-ms" {
        return Err(usage().to_owned());
    }
    let Some(timeout) = arguments.next() else {
        return Err(usage().to_owned());
    };
    let timeout_ms = timeout
        .parse::<u32>()
        .ok()
        .filter(|timeout_ms| *timeout_ms > 0)
        .ok_or_else(|| "--timeout-ms must be a positive whole number of milliseconds".to_owned())?;
    if arguments.next().as_deref() != Some("--") {
        return Err(usage().to_owned());
    }
    let command: Vec<_> = arguments.collect();
    if command.is_empty() || command[0].is_empty() {
        return Err("a program is required after --".to_owned());
    }
    if command.iter().any(|argument| argument.contains('\0')) {
        return Err("command arguments must not contain NUL bytes".to_owned());
    }
    Ok(Arguments {
        timeout_ms,
        command,
    })
}

#[cfg(windows)]
mod platform {
    use super::{Arguments, CANCEL_GRACE_MS};
    use std::ffi::OsStr;
    use std::iter;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Console::{
        GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_BREAK_EVENT,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, ResumeThread, WaitForSingleObject,
        CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
        STARTUPINFOW,
    };

    struct Handle(HANDLE);

    impl Handle {
        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn last_error(context: &str) -> String {
        format!("{context} (Win32 error {})", unsafe { GetLastError() })
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(iter::once(0))
            .collect()
    }

    // Windows command-line parsing preserves argv exactly for the common CRT-compatible case.
    fn quote_argument(argument: &str) -> String {
        if !argument.is_empty()
            && !argument
                .bytes()
                .any(|byte| matches!(byte, b' ' | b'\t' | b'\"'))
        {
            return argument.to_owned();
        }
        let mut quoted = String::from("\"");
        let mut backslashes = 0;
        for character in argument.chars() {
            match character {
                '\\' => backslashes += 1,
                '\"' => {
                    quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                    quoted.push('\"');
                    backslashes = 0;
                }
                _ => {
                    quoted.push_str(&"\\".repeat(backslashes));
                    quoted.push(character);
                    backslashes = 0;
                }
            }
        }
        quoted.push_str(&"\\".repeat(backslashes * 2));
        quoted.push('\"');
        quoted
    }

    #[cfg(test)]
    mod tests {
        use super::quote_argument;

        #[test]
        fn quotes_windows_command_line_arguments() {
            assert_eq!(quote_argument("worker.exe"), "worker.exe");
            assert_eq!(quote_argument("two words"), "\"two words\"");
            assert_eq!(quote_argument(""), "\"\"");
            assert_eq!(quote_argument("a\"b"), "\"a\\\"b\"");
            assert_eq!(
                quote_argument(r#"C:\path with space\"#),
                r#""C:\path with space\\""#
            );
            assert_eq!(quote_argument(r#"a\\"b"#), r#""a\\\\\"b""#);
        }
    }

    pub fn run(arguments: Arguments) -> Result<i32, String> {
        let command_line = arguments
            .command
            .iter()
            .map(|argument| quote_argument(argument))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command_line = wide(&command_line);
        let mut startup: STARTUPINFOW = unsafe { zeroed() };
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        // CREATE_PROCESS inherits the helper's existing standard handles when requested.
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput =
            unsafe { windows_sys::Win32::System::Console::GetStdHandle(-10i32 as u32) };
        startup.hStdOutput =
            unsafe { windows_sys::Win32::System::Console::GetStdHandle(-11i32 as u32) };
        startup.hStdError =
            unsafe { windows_sys::Win32::System::Console::GetStdHandle(-12i32 as u32) };
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };

        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut process_info,
            )
        };
        if created == 0 {
            return Err(last_error("CreateProcessW failed"));
        }
        let process = Handle(process_info.hProcess);
        let thread = Handle(process_info.hThread);
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.raw(), 1) };
            return Err(last_error(
                "CreateJobObjectW failed; suspended process terminated",
            ));
        }
        let job = Handle(raw_job);

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            // The process is still suspended. Closing the configured job cannot leave it running.
            unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.raw(), 1) };
            return Err(last_error("SetInformationJobObject failed"));
        }
        if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
            // Assignment is a hard boundary: never resume an unassigned process.
            unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.raw(), 1) };
            return Err(last_error(
                "AssignProcessToJobObject failed; suspended process terminated",
            ));
        }
        if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
            return Err(last_error(
                "ResumeThread failed; job closing will terminate the process tree",
            ));
        }

        match unsafe { WaitForSingleObject(process.raw(), arguments.timeout_ms) } {
            WAIT_OBJECT_0 => exit_code(process.raw()),
            WAIT_TIMEOUT => {
                // Best-effort cooperative cancellation; closing the job after the fixed grace kills the tree.
                unsafe { SetConsoleCtrlHandler(None, 1) };
                unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process_info.dwProcessId) };
                unsafe { WaitForSingleObject(process.raw(), CANCEL_GRACE_MS) };
                unsafe { SetConsoleCtrlHandler(None, 0) };
                drop(job);
                Err(format!(
                    "worker timed out after {} ms; job closed",
                    arguments.timeout_ms
                ))
            }
            _ => Err(last_error("WaitForSingleObject failed")),
        }
    }

    fn exit_code(process: HANDLE) -> Result<i32, String> {
        let mut code = 0;
        if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
            return Err(last_error("GetExitCodeProcess failed"));
        }
        Ok(code as i32)
    }
}

fn main() -> ExitCode {
    let arguments = match parse_arguments(env::args().skip(1)) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };

    #[cfg(windows)]
    match platform::run(arguments) {
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            eprintln!("win-job-launcher: {error}");
            ExitCode::from(124)
        }
    }

    #[cfg(not(windows))]
    {
        let _ = arguments;
        eprintln!("win-job-launcher is supported only on Windows");
        ExitCode::from(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_command() {
        assert_eq!(
            parse_arguments(
                [
                    "--timeout-ms",
                    "42",
                    "--",
                    "worker.exe",
                    "--input",
                    "handle"
                ]
                .map(str::to_owned)
            ),
            Ok(Arguments {
                timeout_ms: 42,
                command: vec!["worker.exe".into(), "--input".into(), "handle".into()]
            })
        );
    }

    #[test]
    fn rejects_invalid_timeout_and_missing_program() {
        for arguments in [
            vec!["--timeout-ms", "0", "--", "worker.exe"],
            vec!["--timeout-ms", "-1", "--", "worker.exe"],
            vec!["--timeout-ms", "no", "--", "worker.exe"],
            vec!["--timeout-ms", "4294967296", "--", "worker.exe"],
            vec!["--timeout-ms", "10", "--"],
            vec!["--timeout-ms", "10", "worker.exe"],
            vec!["--timeout-ms", "10", "--", ""],
        ] {
            assert!(parse_arguments(arguments.into_iter().map(str::to_owned)).is_err());
        }
    }

    #[test]
    fn accepts_largest_u32_timeout() {
        assert_eq!(
            parse_arguments(["--timeout-ms", "4294967295", "--", "worker.exe"].map(str::to_owned)),
            Ok(Arguments {
                timeout_ms: u32::MAX,
                command: vec!["worker.exe".into()],
            })
        );
    }

    #[test]
    fn rejects_nul_in_every_command_argument() {
        let error = parse_arguments(
            ["--timeout-ms", "10", "--", "worker.exe", "bad\0argument"].map(str::to_owned),
        )
        .unwrap_err();

        assert_eq!(error, "command arguments must not contain NUL bytes");
    }

    #[cfg(windows)]
    mod windows_integration {
        use super::super::{platform, CANCEL_GRACE_MS};
        use super::Arguments;
        use std::time::{Duration, Instant};

        #[test]
        fn returns_the_successful_child_exit_code() {
            let result = platform::run(Arguments {
                timeout_ms: 2_000,
                command: vec!["cmd.exe".into(), "/C".into(), "exit 37".into()],
            });

            assert_eq!(result, Ok(37));
        }

        #[test]
        fn times_out_no_earlier_than_deadline_or_later_than_cancellation_grace() {
            let timeout_ms = 100;
            let started = Instant::now();
            let result = platform::run(Arguments {
                timeout_ms,
                command: vec![
                    "cmd.exe".into(),
                    "/C".into(),
                    "ping -n 10 127.0.0.1 > NUL".into(),
                ],
            });
            let elapsed = started.elapsed();

            assert_eq!(
                result,
                Err(format!(
                    "worker timed out after {timeout_ms} ms; job closed"
                ))
            );
            assert!(elapsed >= Duration::from_millis(timeout_ms as u64));
            assert!(
                elapsed <= Duration::from_secs(4),
                "timeout exceeded the {CANCEL_GRACE_MS} ms cancellation grace: {elapsed:?}"
            );
            println!(
                "Integration limitation: this test verifies job closure for the cmd.exe process tree \
                 without creating a durable true-descendant sentinel; proving descendant termination \
                 requires an external integration harness that can safely observe a child after its \
                 parent and job handles close."
            );
        }
    }
}
