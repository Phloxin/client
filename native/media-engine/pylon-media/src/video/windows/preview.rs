// The preview's Windows half (.plans/native-media-engine-m6-preview-3-windows.md, W2 to W4): the
// picture area of the frame the encoder converted (an NV12 D3D11 texture of the converter's pool,
// BT.709 limited range, possibly taller than the picture) copied to a staging texture of the
// preview's own, read back without ever waiting on the GPU inside a device call, scaled down and
// converted on the CPU (`video/preview_cpu.rs`), and compressed with libavcodec's JPEG encoder
// (`video/jpeg.rs`). Nothing here runs on the encode path.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use ::windows::{
    Win32::Graphics::{
        Direct3D11::{
            D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
            D3D11_USAGE_STAGING, ID3D11Texture2D,
        },
        Dxgi::{
            Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC},
            DXGI_ERROR_WAS_STILL_DRAWING,
        },
    },
    core::Interface,
};

use super::device::Device;
use crate::{
    Error,
    video::{
        ffi::Frame,
        jpeg::{Jpeg, open_jpeg},
        preview::{PreviewMaker, PreviewPicture, Stage, StageTimes, fit},
        preview_cpu::{Nv12, bt709_limited_to_jpeg, shrink},
    },
};

/// The longest the preview waits for the copy to be readable before it skips the frame (W3).
const MAP_WAIT: Duration = Duration::from_millis(200);
/// The sleep between two tries, outside any device call (W3).
const MAP_RETRY: Duration = Duration::from_millis(2);

/// A reference to a converted frame and the size of the picture in it (the texture may be taller,
/// M7 plan F7), for the preview's thread.
pub(crate) struct PreviewFrame {
    pub(crate) frame: Frame,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

// SAFETY: a frame reference is counted atomically by FFmpeg, and only the thread holding the
// `PreviewFrame` touches it; the texture it names is on a multithread protected device.
unsafe impl Send for PreviewFrame {}

/// Makes previews from the converter's NV12 textures.
pub(crate) struct D3d11Preview {
    device: Arc<Device>,
    /// The staging texture the picture area is copied to, and its size.
    staging: Option<(ID3D11Texture2D, (u32, u32))>,
    jpeg: Option<Jpeg>,
}

impl D3d11Preview {
    pub(crate) fn new(device: Arc<Device>) -> D3d11Preview {
        D3d11Preview { device, staging: None, jpeg: None }
    }

    /// The staging texture for a picture of `size`, made again when it changes.
    fn staging_for(&mut self, size: (u32, u32)) -> Result<ID3D11Texture2D, Error> {
        if let Some((texture, made)) = &self.staging
            && *made == size
        {
            return Ok(texture.clone());
        }
        self.staging = None;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: the description lives through the call.
        unsafe { self.device.device.CreateTexture2D(&desc, None, Some(&mut texture)) }
            .map_err(|e| Error::Media(format!("preview staging texture: {e}")))?;
        let texture = texture.ok_or_else(|| Error::Media("preview staging texture: none made".into()))?;
        tracing::info!(width = size.0, height = size.1, "preview staging texture");
        self.staging = Some((texture.clone(), size));
        Ok(texture)
    }

    /// The JPEG encoder at `size`, opened again when it changes.
    fn jpeg_for(&mut self, size: (u32, u32)) -> Result<&mut Jpeg, Error> {
        if self.jpeg.as_ref().is_some_and(|jpeg| jpeg.size == size) {
            return Ok(self.jpeg.as_mut().expect("checked above"));
        }
        self.jpeg = None;
        let jpeg = open_jpeg(size)?;
        Ok(self.jpeg.insert(jpeg))
    }
}

/// Unmaps the staging texture when dropped.
struct Mapped {
    device: Arc<Device>,
    texture: ID3D11Texture2D,
    mapped: D3D11_MAPPED_SUBRESOURCE,
}

impl Drop for Mapped {
    fn drop(&mut self) {
        // SAFETY: the texture was mapped by this guard's maker.
        self.device.with_context(|context| unsafe { context.Unmap(&self.texture, 0) });
    }
}

impl PreviewMaker for D3d11Preview {
    type Frame = PreviewFrame;

    fn make(&mut self, frame: &PreviewFrame, max: (u32, u32), times: &mut StageTimes) -> Result<Option<PreviewPicture>, Error> {
        let size = (frame.width, frame.height);
        if size.0 % 2 != 0 || size.1 % 2 != 0 {
            return Err(Error::Media(format!("preview of an odd picture {}x{}", size.0, size.1)));
        }
        let output = fit(size.0, size.1, max.0, max.1);
        let staging = self.staging_for(size)?;
        // SAFETY: a D3D11 frame of FFmpeg's: the texture in data[0], its index in an array in data[1].
        let (raw, index) = unsafe { ((*frame.frame.0).data[0] as *mut std::ffi::c_void, (*frame.frame.0).data[1] as usize as u32) };
        // SAFETY: the frame holds its texture for as long as it lives.
        let source = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }.ok_or_else(|| Error::Media("the converted frame has no texture".into()))?;
        // Only the picture area: the rows below it (Quick Sync's rounding to 16) are not copied.
        let area = D3D11_BOX { left: 0, top: 0, front: 0, right: size.0, bottom: size.1, back: 1 };
        // Timed from the copy to the map (A1).
        let readable = times.start();
        self.device.with_context(|context| {
            // SAFETY: both textures are on this device, NV12, and the box is inside the source and
            // the size of the destination.
            unsafe {
                context.CopySubresourceRegion(&staging, 0, 0, 0, 0, source, index, Some(&area));
                // Sent to the GPU now, so that the copy is done when the map is tried.
                context.Flush();
            }
        });
        // W3: the map never waits inside the device call; the waiting is a sleep between tries.
        let began = Instant::now();
        let mapped = loop {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            // SAFETY: the staging texture is the preview's own, mapped for reading.
            let tried = self
                .device
                .with_context(|context| unsafe { context.Map(&staging, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32, Some(&mut mapped)) });
            match tried {
                Ok(()) => break Mapped { device: self.device.clone(), texture: staging.clone(), mapped },
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                    if began.elapsed() >= MAP_WAIT {
                        times.done(Stage::Readable, readable);
                        // Not an error: the next frame offered is tried (W3, R4).
                        tracing::debug!(ms = began.elapsed().as_millis() as u64, "preview skipped, the GPU did not finish the copy in time");
                        return Ok(None);
                    }
                    std::thread::sleep(MAP_RETRY);
                }
                Err(e) => return Err(Error::Media(format!("preview read back: {e}"))),
            }
        };
        times.done(Stage::Readable, readable);
        let pitch = mapped.mapped.RowPitch as usize;
        let (width, height) = (size.0 as usize, size.1 as usize);
        // Up to the end of the UV plane's last row of picture.
        let length = pitch * height + pitch * (height / 2 - 1) + width;
        // SAFETY: a mapped NV12 staging texture of `size`: the Y plane's `height` rows of `pitch`
        // bytes, then the UV plane's `height / 2` rows; the guard keeps it mapped while read.
        let data = unsafe { std::slice::from_raw_parts(mapped.mapped.pData as *const u8, length) };
        let nv12 = Nv12::in_texture(data, pitch, height, width, height)?;
        let jpeg = self.jpeg_for(output)?;
        {
            let mut planes = jpeg.planes()?;
            let started = times.start();
            shrink(&nv12, &mut planes);
            times.done(Stage::Shrink, started);
            drop(mapped);
            let started = times.start();
            bt709_limited_to_jpeg(&mut planes);
            times.done(Stage::Colour, started);
        }
        let started = times.start();
        let data = jpeg.encode()?;
        times.done(Stage::Jpeg, started);
        Ok(Some(PreviewPicture { width: output.0, height: output.1, jpeg: data }))
    }
}
