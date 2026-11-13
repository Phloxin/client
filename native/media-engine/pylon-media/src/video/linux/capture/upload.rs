// The memory path (D4): a frame copied out of a PipeWire memory buffer is uploaded to a VA
// surface and handed on as that surface's DMA-BUF, the way the pattern producer does it.

use std::time::Instant;

use ffmpeg_sys_next as ff;

use super::super::va;
use crate::{
    Error,
    video::{
        DmaBufFrame,
        ffi::{self, Buffer, Frame, check},
    },
};

/// The software format FFmpeg uses for a DRM fourcc of a memory frame.
fn sw_format(fourcc: u32) -> Option<ff::AVPixelFormat> {
    use ff::AVPixelFormat::*;
    Some(match &fourcc.to_le_bytes() {
        b"XR24" => AV_PIX_FMT_BGR0,
        b"AR24" => AV_PIX_FMT_BGRA,
        b"XB24" => AV_PIX_FMT_RGB0,
        b"AB24" => AV_PIX_FMT_RGBA,
        _ => return None,
    })
}

pub(super) struct Upload {
    /// The surfaces for the current kind of frame. They go before the display.
    surfaces: Option<((u32, u32, u32), Buffer)>,
    display: Buffer,
}

// SAFETY: only touched by the pipeline's thread.
unsafe impl Send for Upload {}

impl Upload {
    pub fn new() -> Result<Upload, Error> {
        ffi::quiet_logs();
        Ok(Upload { surfaces: None, display: ffi::device(ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, va::RENDER_NODE)? })
    }

    pub fn frame(&mut self, width: u32, height: u32, fourcc: u32, stride: usize, bytes: &[u8], arrived: Instant) -> Result<DmaBufFrame, Error> {
        let format = sw_format(fourcc)
            .ok_or_else(|| Error::Media(format!("memory format {} is not supported", super::fourcc_text(fourcc))))?;
        if bytes.len() < stride * height as usize || stride < width as usize * 4 {
            return Err(Error::Media(format!("memory frame of {} bytes for {width}x{height} at stride {stride}", bytes.len())));
        }
        let kind = (width, height, fourcc);
        if self.surfaces.as_ref().is_none_or(|(k, _)| *k != kind) {
            self.surfaces = None;
            let surfaces =
                ffi::frames_context(&self.display, ff::AVPixelFormat::AV_PIX_FMT_VAAPI, format, width as i32, height as i32, 4)?;
            tracing::warn!(width, height, format = %super::fourcc_text(fourcc), "capture uploads from memory, no DMA-BUF");
            self.surfaces = Some((kind, surfaces));
        }
        let Some((_, surfaces)) = &self.surfaces else {
            return Err(Error::Media("no surfaces".into()));
        };
        // SAFETY: the picture points into `bytes`, which outlives the transfer, frames are guarded.
        unsafe {
            let picture = Frame::alloc()?;
            (*picture.0).format = format as i32;
            (*picture.0).width = width as i32;
            (*picture.0).height = height as i32;
            (*picture.0).data[0] = bytes.as_ptr() as *mut u8;
            (*picture.0).linesize[0] = stride as i32;
            let surface = Frame::alloc()?;
            check(ff::av_hwframe_get_buffer(surfaces.0, surface.0, 0), "capture surface")?;
            check(ff::av_hwframe_transfer_data(surface.0, picture.0, 0), "capture upload")?;
            // The picture does not own its data.
            (*picture.0).data[0] = std::ptr::null_mut();
            va::export_surface(&surface, width, height, arrived)
        }
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        self.surfaces = None;
    }
}
