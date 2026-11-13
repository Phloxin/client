// The preview's JPEG encoder (.plans/native-media-engine-m6-preview-1-engine.md, R2): a planar
// YUV 4:2:0 full range picture in memory to libavcodec's `mjpeg`. Shared by the Linux and the
// Windows maker (.plans/native-media-engine-m6-preview-3-windows.md, W5), moved here unchanged
// from `linux/preview.rs`.

use std::ptr;

use ffmpeg_sys_next as ff;

use crate::{
    Error,
    video::ffi::{self, Codec, Frame, check},
};

/// The JPEG encoder's quality, as libavcodec's quantizer scale (2 is best, 31 worst). A preview
/// is small and seen small.
const JPEG_QUALITY: i32 = 5;

/// The quantizers `PYLON_PREVIEW_Q` may set: libavcodec's `mjpeg` clips its quantizer scale to its
/// `qmin` and `qmax`, 2 and 31 by default.
const Q_RANGE: std::ops::RangeInclusive<i32> = 2..=31;

/// A test knob for measuring the preview's cost (.plans/native-media-engine-preview-cost.md, A2),
/// not a setting: `PYLON_PREVIEW_Q=<2 to 31>` in the sidecar's environment replaces
/// `JPEG_QUALITY`. Not for the client to set. Anything else is ignored, with a warning.
fn quality_from(value: Option<&str>) -> Result<i32, String> {
    let Some(text) = value else {
        return Ok(JPEG_QUALITY);
    };
    match text.trim().parse::<i32>() {
        Ok(q) if Q_RANGE.contains(&q) => Ok(q),
        _ => Err(text.to_owned()),
    }
}

/// The quantizer the JPEGs are made with, read from the environment once.
fn quality() -> i32 {
    static Q: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    *Q.get_or_init(|| match quality_from(std::env::var("PYLON_PREVIEW_Q").ok().as_deref()) {
        Ok(q) if q != JPEG_QUALITY => {
            tracing::info!(q, "preview JPEG quantizer from PYLON_PREVIEW_Q (a test knob)");
            q
        }
        Ok(q) => q,
        Err(text) => {
            tracing::warn!(value = %text, default = JPEG_QUALITY, "PYLON_PREVIEW_Q is not a quantizer from 2 to 31, ignored");
            JPEG_QUALITY
        }
    })
}

/// The JPEG encoder at one size, and the picture it takes.
pub(crate) struct Jpeg {
    pub(crate) size: (u32, u32),
    codec: Codec,
    /// YUV 4:2:0 planar, full range, `size`.
    pub(crate) picture: Frame,
    packet: ffi::Packet,
}

impl Jpeg {
    pub(crate) fn encode(&mut self) -> Result<Vec<u8>, Error> {
        // SAFETY: the codec and the packet are owned, the picture is valid.
        unsafe {
            check(ff::avcodec_send_frame(self.codec.0, self.picture.0), "preview JPEG")?;
            check(ff::avcodec_receive_packet(self.codec.0, self.packet.0), "preview JPEG packet")?;
            let packet = &*self.packet.0;
            let data = std::slice::from_raw_parts(packet.data, packet.size as usize).to_vec();
            ff::av_packet_unref(self.packet.0);
            Ok(data)
        }
    }

    /// The picture's planes to write, made writable first.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn planes(&mut self) -> Result<super::preview_cpu::Planes<'_>, Error> {
        let (width, height) = (self.size.0 as usize, self.size.1 as usize);
        let (chroma_width, chroma_height) = (width.div_ceil(2), height.div_ceil(2));
        // SAFETY: the picture is YUV 4:2:0 planar of `size` with buffers of its own once writable;
        // each slice ends at the last byte of its plane's last line, and the slices borrow `self`.
        unsafe {
            check(ff::av_frame_make_writable(self.picture.0), "preview picture")?;
            let p = &*self.picture.0;
            let plane = |n: usize, w: usize, h: usize| {
                let stride = p.linesize[n] as usize;
                (std::slice::from_raw_parts_mut(p.data[n], stride * (h - 1) + w), stride)
            };
            let (y, y_stride) = plane(0, width, height);
            let (u, u_stride) = plane(1, chroma_width, chroma_height);
            let (v, v_stride) = plane(2, chroma_width, chroma_height);
            Ok(super::preview_cpu::Planes { width, height, y, y_stride, u, u_stride, v, v_stride })
        }
    }
}

/// libavcodec's JPEG encoder for `size`, full range YUV 4:2:0, and a picture for it.
pub(crate) fn open_jpeg(size: (u32, u32)) -> Result<Jpeg, Error> {
    // SAFETY: the context, picture and packet are owned by guards.
    unsafe {
        let codec = ff::avcodec_find_encoder(ff::AVCodecID::AV_CODEC_ID_MJPEG);
        if codec.is_null() {
            return Err(Error::Media("this FFmpeg has no JPEG encoder".into()));
        }
        let context = Codec(ff::avcodec_alloc_context3(codec));
        if context.0.is_null() {
            return Err(Error::Media("avcodec_alloc_context3 failed".into()));
        }
        let c = context.0;
        (*c).width = size.0 as i32;
        (*c).height = size.1 as i32;
        (*c).time_base = ff::AVRational { num: 1, den: 1000 };
        (*c).pix_fmt = ff::AVPixelFormat::AV_PIX_FMT_YUV420P;
        (*c).color_range = ff::AVColorRange::AVCOL_RANGE_JPEG;
        (*c).colorspace = ff::AVColorSpace::AVCOL_SPC_BT470BG;
        (*c).flags |= ff::AV_CODEC_FLAG_QSCALE as i32;
        (*c).global_quality = ff::FF_QP2LAMBDA * quality();
        // One thread: the preview is small and must not take the CPU from the share.
        (*c).thread_count = 1;
        check(ff::avcodec_open2(c, codec, ptr::null_mut()), "open the JPEG encoder")?;

        let picture = Frame::alloc()?;
        (*picture.0).format = ff::AVPixelFormat::AV_PIX_FMT_YUV420P as i32;
        (*picture.0).width = size.0 as i32;
        (*picture.0).height = size.1 as i32;
        (*picture.0).color_range = ff::AVColorRange::AVCOL_RANGE_JPEG;
        (*picture.0).quality = (*c).global_quality;
        check(ff::av_frame_get_buffer(picture.0, 0), "preview picture")?;
        let packet = ffi::Packet(ff::av_packet_alloc());
        if packet.0.is_null() {
            return Err(Error::Media("av_packet_alloc failed".into()));
        }
        Ok(Jpeg { size, codec: context, picture, packet })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_jpeg_encoder_makes_a_jpeg_of_the_size() {
        let mut jpeg = open_jpeg((480, 270)).unwrap();
        // SAFETY: a fresh writable picture.
        unsafe {
            check(ff::av_frame_make_writable(jpeg.picture.0), "picture").unwrap();
            let p = &*jpeg.picture.0;
            for plane in 0..3 {
                let lines = if plane == 0 { 270 } else { 135 };
                std::ptr::write_bytes(p.data[plane], 128, p.linesize[plane] as usize * lines);
            }
        }
        let data = jpeg.encode().unwrap();
        // SOI, and the frame header's height and width.
        assert_eq!(&data[..2], &[0xff, 0xd8]);
        let sof = data.windows(2).position(|w| w == [0xff, 0xc0]).expect("a baseline frame header");
        assert_eq!(u16::from_be_bytes([data[sof + 5], data[sof + 6]]), 270);
        assert_eq!(u16::from_be_bytes([data[sof + 7], data[sof + 8]]), 480);
        assert_eq!(&data[data.len() - 2..], &[0xff, 0xd9]);
        // Again: the encoder is reused.
        assert!(jpeg.encode().unwrap().len() > 100);
    }

    #[test]
    fn the_quantizer_knob_takes_2_to_31_and_nothing_else() {
        assert_eq!(quality_from(None), Ok(JPEG_QUALITY));
        assert_eq!(quality_from(Some("2")), Ok(2));
        assert_eq!(quality_from(Some(" 12\n")), Ok(12));
        assert_eq!(quality_from(Some("31")), Ok(31));
        for bad in ["", "1", "32", "0", "-5", "8.5", "high"] {
            assert_eq!(quality_from(Some(bad)), Err(bad.to_owned()), "{bad:?}");
        }
    }

    #[test]
    fn planes_are_the_picture_s_own() {
        let mut jpeg = open_jpeg((6, 4)).unwrap();
        let planes = jpeg.planes().unwrap();
        assert_eq!((planes.width, planes.height), (6, 4));
        assert_eq!(planes.y.len(), planes.y_stride * 3 + 6);
        assert_eq!(planes.u.len(), planes.u_stride + 3);
        assert_eq!(planes.v.len(), planes.v_stride + 3);
        planes.v[planes.v_stride + 2] = 7;
        // SAFETY: the picture's V plane, two rows of at least 3 bytes.
        let written = unsafe { *(*jpeg.picture.0).data[2].offset((*jpeg.picture.0).linesize[2] as isize + 2) };
        assert_eq!(written, 7);
    }
}
