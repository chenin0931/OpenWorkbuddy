use serde_json::{json, Value};
use std::env;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_CHROME_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_CHROME_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_SOCKET_FRAME_BYTES: usize = 64 * 1024 * 1024;

pub fn read_frame<R: Read>(reader: &mut R, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0_u8; 4];
    let first = reader.read(&mut length_bytes[..1])?;
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut length_bytes[1..])?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} exceeds limit {max_bytes}"),
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice::<Value>(&payload).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame is not valid JSON: {error}"),
        )
    })?;
    Ok(Some(payload))
}

pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8], max_bytes: usize) -> io::Result<()> {
    if payload.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("frame length {} exceeds limit {max_bytes}", payload.len()),
        ));
    }
    let length = u32::try_from(payload.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "frame cannot fit in a u32 length",
        )
    })?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

pub fn request_id(payload: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(payload)
        .ok()
        .and_then(|value| value.get("requestId").cloned())
        .filter(|value| value.is_string())
}

pub fn bridge_error_payload(
    request_id: Option<Value>,
    code: &str,
    message: impl Into<String>,
    retryable: bool,
) -> Vec<u8> {
    let mut value = json!({
        "type": "bridge.error",
        "ok": false,
        "error": {
            "code": code,
            "message": message.into(),
            "retryable": retryable
        }
    });
    if let Some(request_id) = request_id {
        value["requestId"] = request_id;
    }
    serde_json::to_vec(&value).expect("serializing a bridge error cannot fail")
}

pub fn socket_path() -> io::Result<PathBuf> {
    socket_path_from(
        env::var_os("ON_MY_WORKBUDDY_SOCKET")
            .as_deref()
            .map(Path::new),
        env::var_os("HOME").as_deref().map(Path::new),
    )
}

pub fn socket_path_from(override_path: Option<&Path>, home: Option<&Path>) -> io::Result<PathBuf> {
    if let Some(path) = override_path {
        if path.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "ON_MY_WORKBUDDY_SOCKET must not be empty",
            ));
        }
        return Ok(path.to_path_buf());
    }
    let home = home.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "HOME is not set and ON_MY_WORKBUDDY_SOCKET was not provided",
        )
    })?;
    Ok(home.join("Library/Application Support/On My WorkBuddy/chrome.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_round_trip() {
        let payload = br#"{"requestId":"one","command":"tabs.list"}"#;
        let mut bytes = Vec::new();
        write_frame(&mut bytes, payload, MAX_SOCKET_FRAME_BYTES).unwrap();
        let decoded = read_frame(&mut Cursor::new(bytes), MAX_SOCKET_FRAME_BYTES)
            .unwrap()
            .unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn rejects_oversized_frame_before_allocating() {
        let bytes = ((MAX_CHROME_OUTPUT_BYTES + 1) as u32)
            .to_le_bytes()
            .to_vec();
        let error = read_frame(&mut Cursor::new(bytes), MAX_CHROME_OUTPUT_BYTES).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_invalid_json() {
        let payload = b"not json";
        let mut bytes = (payload.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(payload);
        let error = read_frame(&mut Cursor::new(bytes), 1024).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn resolves_override_and_default_socket_paths() {
        assert_eq!(
            socket_path_from(Some(Path::new("/tmp/workbuddy.sock")), None).unwrap(),
            PathBuf::from("/tmp/workbuddy.sock")
        );
        assert_eq!(
            socket_path_from(None, Some(Path::new("/Users/example"))).unwrap(),
            PathBuf::from("/Users/example/Library/Application Support/On My WorkBuddy/chrome.sock")
        );
    }

    #[test]
    fn preserves_string_request_id_in_error() {
        let payload = br#"{"requestId":"req-42"}"#;
        let error = bridge_error_payload(
            request_id(payload),
            "DESKTOP_UNAVAILABLE",
            "not connected",
            true,
        );
        let value: Value = serde_json::from_slice(&error).unwrap();
        assert_eq!(value["requestId"], "req-42");
        assert_eq!(value["error"]["code"], "DESKTOP_UNAVAILABLE");
    }
}
