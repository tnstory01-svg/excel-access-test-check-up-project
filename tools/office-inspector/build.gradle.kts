plugins {
    application
}

group = "local.grader"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.apache.poi:poi:5.4.0")
    implementation("org.apache.poi:poi-ooxml:5.4.0")
    implementation("com.healthmarketscience.jackcess:jackcess:4.0.8")
    implementation("io.github.spannm:ucanaccess:5.1.3")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.2")

    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

application {
    mainClass = "local.grader.Main"
}

tasks.test {
    useJUnitPlatform()
}

dependencyLocking {
    lockAllConfigurations()
}
