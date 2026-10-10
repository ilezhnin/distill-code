//! Standalone invented Windows fixture compiled only for the explicit OS probe.

use std::os::windows::process::CommandExt;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--normal-child") {
        return;
    }
    let executable = std::env::current_exe().unwrap();
    let make = || {
        let mut command = std::process::Command::new(&executable);
        command
            .arg("--normal-child")
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());
        command
    };
    // The exact executable and inherited stdio must work without breakaway.
    // NUL/anonymous-pipe ACL failure must never masquerade as Job enforcement.
    let mut ordinary = match make().creation_flags(0x0800_0000).spawn() {
        Ok(child) => child,
        Err(error) => {
            println!(
                "{{\"ordinaryCreateError\":{}}}",
                error.raw_os_error().unwrap_or(-1)
            );
            std::process::exit(1);
        }
    };
    assert!(ordinary.wait().unwrap().success());
    let result = make()
        .creation_flags(0x0100_0000 | 0x0800_0000) // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW
        .spawn();
    match result {
        Err(error) => println!(
            "{{\"ordinaryCreate\":true,\"breakawayError\":{}}}",
            error.raw_os_error().unwrap_or(-1)
        ),
        Ok(mut child) => {
            println!("{{\"unexpectedChild\":{}}}", child.id());
            let _ = child.kill();
            let _ = child.wait();
            std::process::exit(1);
        }
    }
}
