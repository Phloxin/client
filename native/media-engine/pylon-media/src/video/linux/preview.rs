// The preview's Linux half (.plans/native-media-engine-m6-preview-1-engine.md, R2, R7): the
// frame the encoder converted (an NV12 VA surface at the size being encoded) scaled down by the
// VA-API video processor on the preview's own thread, read back, and compressed with
// libavcodec's JPEG encoder (`video/jpeg.rs`). Nothing here runs on the encode path.

use std::{ffi::CString, ptr};

use ffmpeg_sys_next as ff;

use crate::{
    Error,
    video::{
        ffi::{Frame, Graph, check},
        jpeg::{Jpeg, open_jpeg},
        preview::{PreviewMaker, PreviewPicture, Stage, StageTimes, fit},
    },
};

/// A reference to a converted frame, for the preview's thread.
pub(crate) struct PreviewFrame(pub(crate) Frame);

// SAFETY: a frame reference is counted atomically by FFmpeg, and only the thread holding the
// `PreviewFrame` touches it.
unsafe impl Send for PreviewFrame {}

/// The video processor for one kind of input: frames of one frames context, scaled to one size.
struct Scaler {
    /// The input's frames context (compared by address while `_graph` holds a reference to it),
    /// its size and the output size.
    input: (*const u8, u32, u32),
    output: (u32, u32),
    // Owns the filter contexts.
    _graph: Graph,
    source: *mut ff::AVFilterContext,
    sink: *mut ff::AVFilterContext,
}

/// Makes previews from VA surfaces.
#[derive(Default)]
pub(crate) struct VaapiPreview {
    scaler: Option<Scaler>,
    jpeg: Option<Jpeg>,
}

impl VaapiPreview {
    /// The video processor for `frame` to `output`, made again when either changes.
    fn scaler_for(&mut self, frame: &Frame, output: (u32, u32)) -> Result<&Scaler, Error> {
        // SAFETY: the frame is a valid VA frame with a frames context.
        let (frames, width, height) = unsafe {
            let frames = (*frame.0).hw_frames_ctx;
            if frames.is_null() {
                return Err(Error::Media("the converted frame has no frames context".into()));
            }
            ((*frames).data as *const u8, (*frame.0).width as u32, (*frame.0).height as u32)
        };
        let input = (frames, width, height);
        if let Some(scaler) = &self.scaler
            && scaler.input == input
            && scaler.output == output
        {
            return Ok(self.scaler.as_ref().expect("checked above"));
        }
        self.scaler = None;
        let scaler = build_scaler(frame, input, output)?;
        Ok(self.scaler.insert(scaler))
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

impl PreviewMaker for VaapiPreview {
    type Frame = PreviewFrame;

    fn make(&mut self, frame: &PreviewFrame, max: (u32, u32), times: &mut StageTimes) -> Result<Option<PreviewPicture>, Error> {
        let frame = &frame.0;
        // SAFETY: a valid frame.
        let (width, height) = unsafe { ((*frame.0).width as u32, (*frame.0).height as u32) };
        let output = fit(width, height, max.0, max.1);
        // Timed from the scale to the end of the read back (A1).
        let readable = times.start();
        let small = {
            let scaler = self.scaler_for(frame, output)?;
            // SAFETY: frames are owned by guards, the graph lives in self.
            unsafe {
                let input = ff::av_frame_clone(frame.0);
                if input.is_null() {
                    return Err(Error::Media("av_frame_clone failed".into()));
                }
                let input = Frame(input);
                check(ff::av_buffersrc_add_frame_flags(scaler.source, input.0, 0), "preview scale in")?;
                drop(input);
                let small = Frame::alloc()?;
                check(ff::av_buffersink_get_frame(scaler.sink, small.0), "preview scale out")?;
                small
            }
        };
        // Read back to memory, NV12.
        let memory = Frame::alloc()?;
        // SAFETY: the target is fresh, the transfer allocates its buffer.
        unsafe {
            (*memory.0).format = ff::AVPixelFormat::AV_PIX_FMT_NV12 as i32;
            check(ff::av_hwframe_transfer_data(memory.0, small.0, 0), "preview read back")?;
        }
        drop(small);
        times.done(Stage::Readable, readable);
        let jpeg = self.jpeg_for(output)?;
        // The GPU converted the colour: what is timed as the colour stage is the split into planes.
        let split = times.start();
        // SAFETY: both frames are valid, `memory` is NV12 and `picture` YUV 4:2:0 planar of the
        // same size, writable once made so.
        unsafe {
            check(ff::av_frame_make_writable(jpeg.picture.0), "preview picture")?;
            nv12_to_planar(&*memory.0, &mut *jpeg.picture.0, output);
        }
        times.done(Stage::Colour, split);
        drop(memory);
        let started = times.start();
        let data = jpeg.encode()?;
        times.done(Stage::Jpeg, started);
        Ok(Some(PreviewPicture { width: output.0, height: output.1, jpeg: data }))
    }
}

/// Copies an NV12 picture into a planar one of the same size (Y as it is, U and V apart).
///
/// # Safety
/// `nv12` holds an NV12 picture of at least `size`, `planar` a writable YUV 4:2:0 planar one of
/// `size`.
unsafe fn nv12_to_planar(nv12: &ff::AVFrame, planar: &mut ff::AVFrame, size: (u32, u32)) {
    let (width, height) = (size.0 as usize, size.1 as usize);
    let (chroma_width, chroma_height) = (width.div_ceil(2), height.div_ceil(2));
    // SAFETY: as the caller promises, every line read and written is inside its plane.
    unsafe {
        for y in 0..height {
            let from = nv12.data[0].offset(y as isize * nv12.linesize[0] as isize);
            let to = planar.data[0].offset(y as isize * planar.linesize[0] as isize);
            ptr::copy_nonoverlapping(from, to, width);
        }
        for y in 0..chroma_height {
            let from = std::slice::from_raw_parts(nv12.data[1].offset(y as isize * nv12.linesize[1] as isize), chroma_width * 2);
            let u = std::slice::from_raw_parts_mut(planar.data[1].offset(y as isize * planar.linesize[1] as isize), chroma_width);
            let v = std::slice::from_raw_parts_mut(planar.data[2].offset(y as isize * planar.linesize[2] as isize), chroma_width);
            for x in 0..chroma_width {
                u[x] = from[2 * x];
                v[x] = from[2 * x + 1];
            }
        }
    }
}

/// A graph from frames like `frame` to `output`: `scale_vaapi` to NV12 in full range with the
/// BT.601 matrix, which is what a JPEG viewer takes JPEG's YCbCr to be.
fn build_scaler(frame: &Frame, input: (*const u8, u32, u32), output: (u32, u32)) -> Result<Scaler, Error> {
    let (_, width, height) = input;
    // SAFETY: every pointer below is checked or owned by a guard that frees it.
    unsafe {
        let graph = Graph(ff::avfilter_graph_alloc());
        if graph.0.is_null() {
            return Err(Error::Media("avfilter_graph_alloc failed".into()));
        }
        let source = ff::avfilter_graph_alloc_filter(graph.0, ff::avfilter_get_by_name(c"buffer".as_ptr()), c"in".as_ptr());
        if source.is_null() {
            return Err(Error::Media("no buffer filter".into()));
        }
        let parameters = ff::av_buffersrc_parameters_alloc();
        if parameters.is_null() {
            return Err(Error::Media("av_buffersrc_parameters_alloc failed".into()));
        }
        (*parameters).format = ff::AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
        (*parameters).width = width as i32;
        (*parameters).height = height as i32;
        (*parameters).time_base = ff::AVRational { num: 1, den: 1000 };
        (*parameters).hw_frames_ctx = (*frame.0).hw_frames_ctx;
        // What the encoder's converter puts out (encoder.rs, D4).
        (*parameters).color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
        (*parameters).color_space = ff::AVColorSpace::AVCOL_SPC_BT709;
        let set = ff::av_buffersrc_parameters_set(source, parameters);
        ff::av_free(parameters as *mut _);
        check(set, "preview buffer source parameters")?;
        check(ff::avfilter_init_str(source, ptr::null()), "preview buffer source")?;

        let mut sink = ptr::null_mut();
        check(
            ff::avfilter_graph_create_filter(
                &mut sink,
                ff::avfilter_get_by_name(c"buffersink".as_ptr()),
                c"out".as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                graph.0,
            ),
            "preview buffer sink",
        )?;
        let spec = format!("scale_vaapi=w={}:h={}:format=nv12:out_color_matrix=bt470bg:out_range=full", output.0, output.1);
        let spec = CString::new(spec).map_err(|_| Error::Media("filter text".into()))?;
        let mut outputs = ff::avfilter_inout_alloc();
        let mut inputs = ff::avfilter_inout_alloc();
        if outputs.is_null() || inputs.is_null() {
            ff::avfilter_inout_free(&mut outputs);
            ff::avfilter_inout_free(&mut inputs);
            return Err(Error::Media("avfilter_inout_alloc failed".into()));
        }
        (*outputs).name = ff::av_strdup(c"in".as_ptr());
        (*outputs).filter_ctx = source;
        (*inputs).name = ff::av_strdup(c"out".as_ptr());
        (*inputs).filter_ctx = sink;
        let parsed = ff::avfilter_graph_parse_ptr(graph.0, spec.as_ptr(), &mut inputs, &mut outputs, ptr::null_mut());
        ff::avfilter_inout_free(&mut outputs);
        ff::avfilter_inout_free(&mut inputs);
        check(parsed, "preview scale graph")?;
        check(ff::avfilter_graph_config(graph.0, ptr::null_mut()), "preview scale graph config")?;
        tracing::info!(width, height, out_width = output.0, out_height = output.1, "preview scale");
        Ok(Scaler { input, output, _graph: graph, source, sink })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nv12_is_split_into_planes() {
        let size = (4u32, 2u32);
        // SAFETY: frames made here with buffers of the size used.
        unsafe {
            let nv12 = Frame::alloc().unwrap();
            (*nv12.0).format = ff::AVPixelFormat::AV_PIX_FMT_NV12 as i32;
            (*nv12.0).width = 4;
            (*nv12.0).height = 2;
            check(ff::av_frame_get_buffer(nv12.0, 0), "nv12").unwrap();
            for y in 0..2 {
                let line = std::slice::from_raw_parts_mut((*nv12.0).data[0].offset(y * (*nv12.0).linesize[0] as isize), 4);
                line.copy_from_slice(&[10 + y as u8, 11, 12, 13]);
            }
            std::slice::from_raw_parts_mut((*nv12.0).data[1], 4).copy_from_slice(&[1, 2, 3, 4]);
            let planar = Frame::alloc().unwrap();
            (*planar.0).format = ff::AVPixelFormat::AV_PIX_FMT_YUV420P as i32;
            (*planar.0).width = 4;
            (*planar.0).height = 2;
            check(ff::av_frame_get_buffer(planar.0, 0), "planar").unwrap();
            nv12_to_planar(&*nv12.0, &mut *planar.0, size);
            let p = &*planar.0;
            assert_eq!(std::slice::from_raw_parts(p.data[0], 4), &[10, 11, 12, 13]);
            assert_eq!(std::slice::from_raw_parts(p.data[0].offset(p.linesize[0] as isize), 4), &[11, 11, 12, 13]);
            assert_eq!(std::slice::from_raw_parts(p.data[1], 2), &[1, 3]);
            assert_eq!(std::slice::from_raw_parts(p.data[2], 2), &[2, 4]);
        }
    }
}
