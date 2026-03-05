use base64::Engine;
use image::Luma;
use qrcode::QrCode;
use std::io::Cursor;

/// Generate a QR code from the given URL and return it as a base64-encoded PNG data URI.
///
/// The returned string is in the format `data:image/png;base64,<base64-data>`.
pub fn generate_qr_data_uri(url: &str) -> Result<String, String> {
    // Create the QR code from the URL string.
    let code = QrCode::new(url.as_bytes())
        .map_err(|e| format!("QR code generation failed: {}", e))?;

    // Render to an image buffer (Luma grayscale).
    let image = code.render::<Luma<u8>>().build();

    // Encode to PNG in memory.
    let mut png_bytes: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut png_bytes);
    image
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encoding failed: {}", e))?;

    // Base64-encode the PNG bytes.
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);

    Ok(format!("data:image/png;base64,{}", b64))
}
