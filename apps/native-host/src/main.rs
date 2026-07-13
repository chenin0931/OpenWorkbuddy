use on_my_workbuddy_native_host::{
    bridge_error_payload, read_frame, request_id, socket_path, write_frame, MAX_CHROME_INPUT_BYTES,
    MAX_CHROME_OUTPUT_BYTES, MAX_SOCKET_FRAME_BYTES,
};
use std::io::{self, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    if let Err(error) = run() {
        eprintln!("OpenWorkbuddy native host stopped: {error}");
        std::process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let path = socket_path()?;
    let stream = match UnixStream::connect(&path) {
        Ok(stream) => stream,
        Err(error) => return run_disconnected(error, &path.display().to_string()),
    };

    let chrome_stdout = Arc::new(Mutex::new(io::stdout()));
    let mut socket_writer = stream.try_clone()?;
    let stdout_for_input = Arc::clone(&chrome_stdout);

    let _input_thread = thread::Builder::new()
        .name("chrome-to-workbuddy".into())
        .spawn(move || -> io::Result<()> {
            let stdin = io::stdin();
            let mut input = stdin.lock();
            loop {
                let Some(payload) = read_frame(&mut input, MAX_CHROME_INPUT_BYTES)? else {
                    let _ = socket_writer.shutdown(Shutdown::Both);
                    return Ok(());
                };
                if let Err(error) =
                    write_frame(&mut socket_writer, &payload, MAX_SOCKET_FRAME_BYTES)
                {
                    emit_bridge_error(
                        &stdout_for_input,
                        request_id(&payload),
                        "DESKTOP_DISCONNECTED",
                        format!("Could not forward the Chrome message: {error}"),
                        true,
                    )?;
                    let _ = socket_writer.shutdown(Shutdown::Both);
                    return Err(error);
                }
            }
        })?;

    let mut socket_reader = stream;
    loop {
        match read_frame(&mut socket_reader, MAX_SOCKET_FRAME_BYTES) {
            Ok(Some(payload)) => {
                if payload.len() > MAX_CHROME_OUTPUT_BYTES {
                    emit_bridge_error(
                        &chrome_stdout,
                        request_id(&payload),
                        "MESSAGE_TOO_LARGE",
                        format!(
                            "Desktop-to-Chrome message is {} bytes; Chrome permits at most {} bytes",
                            payload.len(),
                            MAX_CHROME_OUTPUT_BYTES
                        ),
                        false,
                    )?;
                    continue;
                }
                let mut output = chrome_stdout
                    .lock()
                    .map_err(|_| io::Error::other("Chrome stdout mutex was poisoned"))?;
                write_frame(&mut *output, &payload, MAX_CHROME_OUTPUT_BYTES)?;
            }
            Ok(None) => {
                emit_bridge_error(
                    &chrome_stdout,
                    None,
                    "DESKTOP_DISCONNECTED",
                    "The OpenWorkbuddy desktop socket closed.",
                    true,
                )?;
                break;
            }
            Err(error) => {
                emit_bridge_error(
                    &chrome_stdout,
                    None,
                    "DESKTOP_PROTOCOL_ERROR",
                    format!("Could not read from the desktop socket: {error}"),
                    true,
                )?;
                break;
            }
        }
    }

    // Do not join the input thread here: Chrome may keep stdin open after the
    // desktop socket disconnects. Returning lets Chrome observe process exit
    // and reconnect a fresh native host instead of deadlocking this process.
    Ok(())
}

fn run_disconnected(connect_error: io::Error, socket_display: &str) -> io::Result<()> {
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let message = format!(
        "Could not connect to the OpenWorkbuddy socket at {socket_display}: {connect_error}"
    );

    emit_bridge_error(&stdout, None, "DESKTOP_UNAVAILABLE", message.clone(), true)?;

    // Exit after reporting the failure. The MV3 service worker reconnects with
    // backoff, so a desktop app started later can accept a fresh host process.
    Ok(())
}

fn emit_bridge_error<W: Write + Send + 'static>(
    stdout: &Arc<Mutex<W>>,
    request_id: Option<serde_json::Value>,
    code: &str,
    message: impl Into<String>,
    retryable: bool,
) -> io::Result<()> {
    let payload = bridge_error_payload(request_id, code, message, retryable);
    let mut output = stdout
        .lock()
        .map_err(|_| io::Error::other("Chrome stdout mutex was poisoned"))?;
    write_frame(&mut *output, &payload, MAX_CHROME_OUTPUT_BYTES)
}
