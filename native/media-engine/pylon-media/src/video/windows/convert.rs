// Colour conversion and scaling on the GPU with our own D3D11 video processor
// (.plans/native-media-engine-m7-4-windows-encoder.md, N5; FFmpeg's scale_d3d11 does not work
// on the test machine, M7 plan F7): BGRA full range in, NV12 BT.709 limited range out, as the
// encoder spike's `d3d11.rs` drives it.

use std::sync::Arc;

use ::windows::{
    Win32::{
        Foundation::RECT,
        Graphics::{
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_VIDEO_ENCODER, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_VIDEO_COLOR,
                D3D11_VIDEO_COLOR_0, D3D11_VIDEO_COLOR_YCbCrA, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
                D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
                D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Texture2D, ID3D11VideoContext1, ID3D11VideoDevice,
                ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorEnumerator1,
            },
            Dxgi::Common::{
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_FORMAT_NV12, DXGI_RATIONAL,
            },
        },
    },
    core::{BOOL, Interface},
};
use ffmpeg_sys_next as ff;

use super::{D3d11Frame, device::Device};
use crate::{
    Error,
    video::ffi::{Buffer, Frame, check},
};

/// A D3D11 frames context of `sw_format` textures of `width` by `height` with `bind` flags, a
/// pool of single textures (no array) that grows as needed.
pub(super) fn frames_context(device: &Device, sw_format: ff::AVPixelFormat, width: u32, height: u32, bind: u32) -> Result<Buffer, Error> {
    // SAFETY: the device is valid, the new context is filled in before init.
    unsafe {
        let frames = ff::av_hwframe_ctx_alloc(device.ffmpeg.0);
        if frames.is_null() {
            return Err(Error::Media("av_hwframe_ctx_alloc failed".into()));
        }
        let frames = Buffer(frames);
        let context = (*frames.0).data as *mut ff::AVHWFramesContext;
        (*context).format = ff::AVPixelFormat::AV_PIX_FMT_D3D11;
        (*context).sw_format = sw_format;
        (*context).width = width as i32;
        (*context).height = height as i32;
        (*context).initial_pool_size = 0;
        (*((*context).hwctx as *mut ff::AVD3D11VAFramesContext)).BindFlags = bind;
        check(ff::av_hwframe_ctx_init(frames.0), "D3D11 frames context")?;
        Ok(frames)
    }
}

/// The video processor for one input size and one output size.
pub(super) struct Converter {
    // Keeps the device the views and the pool are on.
    _device: Arc<Device>,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext1,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    /// The NV12 textures it writes: `out_height` rows, or more with the picture at the top.
    pub(super) frames: Buffer,
}

// SAFETY: the D3D11 objects are free threaded or serialized by the device's multithread
// protection, the FFmpeg frames context is only touched by the thread that owns the converter.
unsafe impl Send for Converter {}

impl Converter {
    /// Converts `input` sized pictures (the top left `input` of their textures) to `output`, into
    /// textures `rows` high (at least the picture's height; the rows below the picture are black).
    pub(super) fn new(device: Arc<Device>, input: (u32, u32), output: (u32, u32), rows: u32, fps: u32) -> Result<Converter, Error> {
        let (out_width, out_height) = output;
        let failed = |what: &str, e: ::windows::core::Error| Error::Media(format!("video processor: {what}: {e}"));
        // SAFETY: COM calls on owned interfaces with descriptions that live through each call.
        unsafe {
            let video_device: ID3D11VideoDevice = device.device.cast().map_err(|e| failed("ID3D11VideoDevice", e))?;
            let video_context: ID3D11VideoContext1 = device.context.cast().map_err(|e| failed("ID3D11VideoContext1", e))?;
            let rate = DXGI_RATIONAL { Numerator: fps, Denominator: 1 };
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: input.0,
                InputHeight: input.1,
                OutputFrameRate: rate,
                OutputWidth: out_width,
                OutputHeight: rows,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&desc).map_err(|e| failed("enumerator", e))?;
            if let Ok(enumerator) = enumerator.cast::<ID3D11VideoProcessorEnumerator1>() {
                let supported = enumerator.CheckVideoProcessorFormatConversion(
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                    DXGI_FORMAT_NV12,
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
                );
                tracing::debug!(supported = ?supported.map(|s| s.as_bool()), "BGRA full range to NV12 BT.709 limited range in the video processor");
            }
            let processor = video_device.CreateVideoProcessor(&enumerator, 0).map_err(|e| failed("processor", e))?;
            video_context.VideoProcessorSetStreamColorSpace1(&processor, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
            video_context.VideoProcessorSetOutputColorSpace1(&processor, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            // Only the picture's own part of the texture: a captured texture can be larger than
            // its content (M7.5 C6).
            let content = RECT { left: 0, top: 0, right: input.0 as i32, bottom: input.1 as i32 };
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&content));
            if rows > out_height {
                // The picture in the top rows, the rest black in studio range (M7 plan F7).
                let picture = RECT { left: 0, top: 0, right: out_width as i32, bottom: out_height as i32 };
                video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&picture));
                let black = D3D11_VIDEO_COLOR {
                    Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 16.0 / 255.0, Cb: 0.5, Cr: 0.5, A: 1.0 } },
                };
                video_context.VideoProcessorSetOutputBackgroundColor(&processor, true, &black);
            }
            let bind = (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32;
            let frames = frames_context(&device, ff::AVPixelFormat::AV_PIX_FMT_NV12, out_width, rows, bind)?;
            Ok(Converter { _device: device, video_device, video_context, enumerator, processor, frames })
        }
    }

    /// `frame` converted into a new NV12 texture of the pool, as an FFmpeg D3D11 frame with the
    /// BT.709 limited range colour fields.
    pub(super) fn convert(&self, frame: &D3d11Frame) -> Result<Frame, Error> {
        let failed = |what: &str, e: ::windows::core::Error| Error::Media(format!("video processor: {what}: {e}"));
        let out = Frame::alloc()?;
        // SAFETY: the output frame is owned, its texture belongs to the pool, the views live
        // through the blit.
        unsafe {
            check(ff::av_hwframe_get_buffer(self.frames.0, out.0, 0), "video processor output texture")?;
            let raw = (*out.0).data[0] as *mut std::ffi::c_void;
            let texture = ID3D11Texture2D::from_raw_borrowed(&raw).ok_or_else(|| Error::Media("video processor output has no texture".into()))?;
            let in_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut in_view = None;
            self.video_device
                .CreateVideoProcessorInputView(&frame.texture, &self.enumerator, &in_desc, Some(&mut in_view))
                .map_err(|e| failed("input view", e))?;
            let out_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut out_view = None;
            self.video_device
                .CreateVideoProcessorOutputView(texture, &self.enumerator, &out_desc, Some(&mut out_view))
                .map_err(|e| failed("output view", e))?;
            let out_view = out_view.ok_or_else(|| Error::Media("video processor: no output view".into()))?;
            let mut streams = [D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: BOOL::from(true),
                pInputSurface: std::mem::ManuallyDrop::new(in_view),
                ..Default::default()
            }];
            let blit = self.video_context.VideoProcessorBlt(&self.processor, &out_view, 0, &streams);
            std::mem::ManuallyDrop::drop(&mut streams[0].pInputSurface);
            blit.map_err(|e| failed("blit", e))?;
            (*out.0).color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
            (*out.0).colorspace = ff::AVColorSpace::AVCOL_SPC_BT709;
            (*out.0).color_primaries = ff::AVColorPrimaries::AVCOL_PRI_BT709;
            (*out.0).color_trc = ff::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        }
        Ok(out)
    }
}
