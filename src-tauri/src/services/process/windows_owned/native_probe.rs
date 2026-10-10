//! Standalone invented Windows child for real filesystem/stdio/descendant probes.
use std::fs;
use std::io::{self, BufRead, Write};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

fn quote(text: &str) -> String {
    let mut result = String::from("\"");
    for character in text.chars() {
        match character {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            value if value.is_control() => result.push_str(&format!("\\u{:04x}", value as u32)),
            value => result.push(value),
        }
    }
    result.push('"');
    result
}
fn read(path: &str) -> String {
    match fs::read_to_string(path) {
        Ok(value) => {
            eprintln!("read {path}: OK");
            format!("{{\"ok\":true,\"value\":{}}}", quote(&value))
        }
        Err(error) => {
            eprintln!("read {path}: OS {:?}", error.raw_os_error());
            format!(
                "{{\"ok\":false,\"error\":{}}}",
                error.raw_os_error().unwrap_or(-1)
            )
        }
    }
}
fn write(path: &str) -> String {
    match fs::write(path, "child-write") {
        Ok(()) => {
            eprintln!("write {path}: OK");
            "{\"ok\":true}".to_owned()
        }
        Err(error) => {
            eprintln!("write {path}: OS {:?}", error.raw_os_error());
            format!(
                "{{\"ok\":false,\"error\":{}}}",
                error.raw_os_error().unwrap_or(-1)
            )
        }
    }
}
fn operation(name: &str, result: io::Result<()>) -> String {
    eprintln!(
        "{name}: {:?}",
        result.as_ref().map_err(|error| error.raw_os_error())
    );
    match result {
        Ok(()) => "{\"ok\":true}".to_owned(),
        Err(error) => format!(
            "{{\"ok\":false,\"error\":{}}}",
            error.raw_os_error().unwrap_or(-1)
        ),
    }
}
fn main() -> io::Result<()> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "--grandchild")
    {
        println!(
            "{{\"pid\":{},\"privateRead\":{}}}",
            std::process::id(),
            read(&arguments[1])
        );
        io::stdout().flush()?;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    let mut input = String::new();
    io::stdin().lock().read_line(&mut input)?;
    eprintln!("owned-native-stderr-marker");
    let workspace = std::path::Path::new(&arguments[2]);
    let existing_rename = operation(
        "rename existing file",
        fs::rename(
            workspace.join("existing-edit.txt"),
            workspace.join("renamed-edit.txt"),
        ),
    );
    let existing_write = write(workspace.join("renamed-edit.txt").to_str().unwrap());
    let existing_delete = operation(
        "delete existing file",
        fs::remove_file(workspace.join("renamed-edit.txt")),
    );
    let existing_directory_rename = operation(
        "rename existing directory",
        fs::rename(
            workspace.join("existing-dir"),
            workspace.join("renamed-existing-dir"),
        ),
    );
    let directory_create = operation(
        "create directory",
        fs::create_dir(workspace.join("child-directory")),
    );
    let directory_rename = operation(
        "rename created directory",
        fs::rename(
            workspace.join("child-directory"),
            workspace.join("renamed-child-directory"),
        ),
    );
    let directory_delete = operation(
        "delete created directory",
        fs::remove_dir(workspace.join("renamed-child-directory")),
    );
    let executable = std::env::current_exe()?;
    let runtime_read = fs::read(&executable);
    eprintln!(
        "read own staged executable: {:?}",
        runtime_read
            .as_ref()
            .map(|bytes| bytes.len())
            .map_err(|error| error.raw_os_error())
    );
    let child = Command::new(&executable)
        .args(["--grandchild", &arguments[0]])
        .creation_flags(0x00000008) // DETACHED_PROCESS, without breakaway.
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();
    eprintln!(
        "spawn detached inherited-stdio child: {:?}",
        child
            .as_ref()
            .map(|child| child.id())
            .map_err(|error| error.raw_os_error())
    );
    let child = child?;
    println!("{{\"pid\":{},\"input\":{},\"public\":{},\"workspaceWrite\":{},\"homeWrite\":{},\"tempWrite\":{},\"privateRead\":{},\"privateWrite\":{},\"siblingRead\":{},\"siblingWrite\":{},\"runtimeWrite\":{},\"lpacCanaryRead\":{},\"home\":{},\"temp\":{},\"grandchildPid\":{},\"existingRename\":{},\"existingWrite\":{},\"existingDelete\":{},\"existingDirectoryRename\":{},\"directoryCreate\":{},\"directoryRename\":{},\"directoryDelete\":{}}}",
        std::process::id(), quote(&input), read(&format!("{}/public.txt", arguments[2])),
        write(&format!("{}/child-output.txt", arguments[2])), write(&format!("{}/child-output.txt", arguments[3])), write(&format!("{}/child-output.txt", arguments[4])),
        read(&arguments[0]), write(&arguments[0]), read(&arguments[1]), write(&arguments[1]), write(&arguments[5]), read(&arguments[6]),
        quote(&std::env::var("HOME").unwrap_or_default()), quote(&std::env::var("TEMP").unwrap_or_default()), child.id(), existing_rename, existing_write, existing_delete, existing_directory_rename, directory_create, directory_rename, directory_delete);
    io::stdout().flush()?;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
