// AV1 on the wire (AV1 step 2, Q5, Q6, Q9): the RTP payload format of the Alliance for Open
// Media ("RTP Payload Format For AV1", v1.0.0, https://aomediacodec.github.io/av1-rtp-spec/),
// section 4 (aggregation header, OBU elements), section 5 (packetization rules) and Appendix A
// (the Dependency Descriptor, A.8.2 syntax and A.8.3 semantics). And an IVF reader for the file
// source.
//
// The packetizer's input is a temporal unit as the encoder or the E2EE crate leaves it: OBUs with
// clear headers, each with or without an `obu_size` field. Only OBU headers and sizes are read.

use crate::Error;

/// OBU types (AV1 specification, section 6.2.2).
pub const OBU_SEQUENCE_HEADER: u8 = 1;
pub const OBU_TEMPORAL_DELIMITER: u8 = 2;
pub const OBU_TILE_LIST: u8 = 8;

const OBU_FORBIDDEN: u8 = 0x80;
const OBU_HAS_EXTENSION: u8 = 0x04;
const OBU_HAS_SIZE: u8 = 0x02;

/// The URI of the Dependency Descriptor header extension (Appendix A.9).
pub const DEPENDENCY_DESCRIPTOR_URI: &str = "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension";

// ─── leb128 (AV1 specification, section 4.10.5) ──────────────────

/// A leb128 value at the start of `data` and the bytes it took. At most 8 bytes, as the AV1
/// specification allows.
fn leb128_read(data: &[u8]) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    for (i, &byte) in data.iter().take(8).enumerate() {
        value |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
    }
    None
}

fn leb128_len(mut value: usize) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}

fn leb128_write(mut value: usize, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

// ─── OBUs ────────────────────────────────────────────────────────

/// One OBU of a temporal unit: its header byte, its extension byte if any, its payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Obu<'a> {
    pub header: u8,
    pub extension: Option<u8>,
    pub payload: &'a [u8],
}

impl Obu<'_> {
    /// `obu_type`.
    pub fn kind(&self) -> u8 {
        self.header >> 3 & 0x0f
    }
}

/// The OBUs of a temporal unit. An OBU without a size field runs to the end.
pub fn obus(mut data: &[u8]) -> Result<Vec<Obu<'_>>, Error> {
    let mut obus = Vec::new();
    while let Some(&header) = data.first() {
        if header & OBU_FORBIDDEN != 0 {
            return Err(Error::invalid("OBU with the forbidden bit set"));
        }
        let mut at = 1;
        let extension = if header & OBU_HAS_EXTENSION != 0 {
            at += 1;
            Some(*data.get(1).ok_or_else(|| Error::invalid("OBU extension header cut short"))?)
        } else {
            None
        };
        let size = if header & OBU_HAS_SIZE != 0 {
            let (size, used) = leb128_read(data.get(at..).unwrap_or_default()).ok_or_else(|| Error::invalid("OBU size cut short"))?;
            at += used;
            usize::try_from(size).map_err(|_| Error::invalid("OBU size too large"))?
        } else {
            data.len().saturating_sub(at)
        };
        let end = at.checked_add(size).ok_or_else(|| Error::invalid("OBU size too large"))?;
        let payload = data.get(at..end).ok_or_else(|| Error::invalid("OBU runs past the end of the frame"))?;
        obus.push(Obu { header, extension, payload });
        data = &data[end..];
    }
    Ok(obus)
}

/// Whether a temporal unit starts a coded video sequence: it has a sequence header (Q9).
pub fn has_sequence_header(data: &[u8]) -> bool {
    obus(data).is_ok_and(|obus| obus.iter().any(|obu| obu.kind() == OBU_SEQUENCE_HEADER))
}

// ─── The packetizer (section 4.4, 4.5, 5) ────────────────────────

/// The aggregation header's bits (section 4.4).
const AGG_Z: u8 = 0x80;
const AGG_Y: u8 = 0x40;
const AGG_W_SHIFT: u8 = 4;
const AGG_N: u8 = 0x08;

/// One RTP payload being filled: the lengths and bytes of its OBU elements.
#[derive(Default)]
struct Building {
    /// The first element continues an OBU from the packet before (Z).
    continues: bool,
    elements: Vec<Vec<u8>>,
}

/// The payload size of a packet with elements of these lengths (aggregation header included).
/// Up to three elements W gives their number and the last has no length field; with four or
/// more W is 0 and every element has one.
fn payload_size(lens: impl Iterator<Item = usize> + Clone) -> usize {
    let count = lens.clone().count();
    let data: usize = lens.clone().sum();
    let fields: usize = if count <= 3 {
        lens.take(count.saturating_sub(1)).map(leb128_len).sum()
    } else {
        lens.map(leb128_len).sum()
    };
    1 + data + fields
}

impl Building {
    fn size_with(&self, extra: usize) -> usize {
        payload_size(self.elements.iter().map(Vec::len).chain(std::iter::once(extra)))
    }

    /// The finished payload. `ends_in_fragment`: the last element continues in the next packet
    /// (Y). `first_of_sequence`: N.
    fn finish(self, ends_in_fragment: bool, first_of_sequence: bool) -> Vec<u8> {
        let count = self.elements.len();
        let w = if count <= 3 { count as u8 } else { 0 };
        let mut header = w << AGG_W_SHIFT;
        if self.continues {
            header |= AGG_Z;
        }
        if ends_in_fragment {
            header |= AGG_Y;
        }
        if first_of_sequence {
            header |= AGG_N;
        }
        let mut out = Vec::with_capacity(payload_size(self.elements.iter().map(Vec::len)));
        out.push(header);
        for (index, element) in self.elements.iter().enumerate() {
            if w == 0 || index + 1 < count {
                leb128_write(element.len(), &mut out);
            }
            out.extend_from_slice(element);
        }
        out
    }
}

/// RTP payloads for one temporal unit, none larger than `limit` bytes.
///
/// Every OBU becomes an OBU element without its size field (`obu_has_size_field` cleared, as
/// section 4.5 recommends). Temporal delimiters and tile lists are left out (section 5). OBUs
/// are packed in order, and an OBU that does not fit the rest of a packet is split there. With
/// `key` the first packet has N set (section 4.4: the first packet of a coded video sequence).
pub fn packetize(frame: &[u8], key: bool, limit: usize) -> Result<Vec<Vec<u8>>, Error> {
    // The aggregation header, a two byte length and one byte of data always fit.
    if limit < 4 {
        return Err(Error::invalid(format!("payload limit {limit} is too small")));
    }
    let elements: Vec<Vec<u8>> = obus(frame)?
        .into_iter()
        .filter(|obu| !matches!(obu.kind(), OBU_TEMPORAL_DELIMITER | OBU_TILE_LIST))
        .map(|obu| {
            let mut element = Vec::with_capacity(2 + obu.payload.len());
            element.push(obu.header & !OBU_HAS_SIZE);
            element.extend(obu.extension);
            element.extend_from_slice(obu.payload);
            element
        })
        .collect();

    let mut packets = Vec::new();
    let mut building = Building::default();
    for element in elements {
        let mut rest = element.as_slice();
        loop {
            if building.size_with(rest.len()) <= limit {
                building.elements.push(rest.to_vec());
                break;
            }
            // The largest piece of `rest` that still fits this packet.
            let mut piece = limit.saturating_sub(building.size_with(0));
            while piece > 0 && building.size_with(piece) > limit {
                piece -= 1;
            }
            if piece == 0 {
                // No room left: the element starts in the next packet.
                let first = packets.is_empty();
                packets.push(std::mem::take(&mut building).finish(false, key && first));
                continue;
            }
            building.elements.push(rest[..piece].to_vec());
            rest = &rest[piece..];
            let first = packets.is_empty();
            packets.push(std::mem::replace(&mut building, Building { continues: true, elements: Vec::new() }).finish(true, key && first));
        }
    }
    if !building.elements.is_empty() {
        let first = packets.is_empty();
        packets.push(building.finish(false, key && first));
    }
    Ok(packets)
}

// ─── The Dependency Descriptor (Appendix A) ──────────────────────

/// The descriptor of one packet (Q6): one spatial and one temporal layer, one decode target,
/// one chain, two templates. Template 0 is a key frame that depends on nothing, template 1 a
/// frame that depends on the frame before. It is the structure libwebrtc's
/// `ScalableVideoControllerNoLayering` gives (both DTIs Switch, chain diffs 0 and 1, frame
/// diffs none and 1), sent with `template_id_offset` 0 and no render resolutions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DependencyDescriptor {
    pub start_of_frame: bool,
    pub end_of_frame: bool,
    /// A key frame (template 0) or a frame that depends on the frame before (template 1).
    pub key: bool,
    pub frame_number: u16,
    /// The template dependency structure is attached: the first packet of a key frame.
    pub structure: bool,
}

/// `template_id_offset` of the one structure sent.
const TEMPLATE_ID_OFFSET: u64 = 0;
const TEMPLATE_KEY: u64 = 0;
const TEMPLATE_DELTA: u64 = 1;
/// The Switch indication (Table A.1).
const DTI_SWITCH: u64 = 2;

/// Writes bits high to low order, as `f(n)` reads them (A.8.2).
#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    bits: usize,
}

impl BitWriter {
    fn write(&mut self, n: usize, value: u64) {
        for i in (0..n).rev() {
            if self.bits % 8 == 0 {
                self.bytes.push(0);
            }
            if value >> i & 1 == 1 {
                let last = self.bytes.len() - 1;
                self.bytes[last] |= 0x80 >> (self.bits % 8);
            }
            self.bits += 1;
        }
    }

    /// `write_ns(n, v)` (A.8.2).
    fn write_ns(&mut self, n: u64, v: u64) {
        if n == 1 {
            return;
        }
        let mut w = 0;
        let mut x = n;
        while x != 0 {
            x >>= 1;
            w += 1;
        }
        let m = (1 << w) - n;
        if v < m {
            self.write(w - 1, v);
        } else {
            self.write(w, v + m);
        }
    }
}

impl DependencyDescriptor {
    /// The extension's bytes. The zero padding fills the last byte (A.8.2).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = BitWriter::default();
        // mandatory_descriptor_fields()
        out.write(1, u64::from(self.start_of_frame));
        out.write(1, u64::from(self.end_of_frame));
        let template = if self.key { TEMPLATE_KEY } else { TEMPLATE_DELTA };
        out.write(6, (template + TEMPLATE_ID_OFFSET) % 64);
        out.write(16, u64::from(self.frame_number));
        if !self.structure {
            // Three bytes: no extended fields, the template gives everything.
            return out.bytes;
        }
        // extended_descriptor_fields(): the structure, no active decode targets bitmask (all are
        // active when a structure comes, A.4), no custom DTIs, frame diffs or chains.
        out.write(1, 1); // template_dependency_structure_present_flag
        out.write(1, 0); // active_decode_targets_present_flag
        out.write(1, 0); // custom_dtis_flag
        out.write(1, 0); // custom_fdiffs_flag
        out.write(1, 0); // custom_chains_flag
        // template_dependency_structure()
        out.write(6, TEMPLATE_ID_OFFSET); // template_id_offset
        out.write(5, 0); // dt_cnt_minus_one: one decode target
        // template_layers(): two templates at spatial 0, temporal 0.
        out.write(2, 0); // next_layer_idc: the next template has the same ids
        out.write(2, 3); // next_layer_idc: no more templates
        // template_dtis(): one decode target, Switch in both templates.
        out.write(2, DTI_SWITCH);
        out.write(2, DTI_SWITCH);
        // template_fdiffs(): the key frame depends on nothing, the other on the frame before.
        out.write(1, 0); // fdiff_follows_flag
        out.write(1, 1); // fdiff_follows_flag
        out.write(4, 0); // fdiff_minus_one: 1
        out.write(1, 0); // fdiff_follows_flag
        // template_chains(): one chain protecting the decode target.
        out.write_ns(2, 1); // chain_cnt = ns(DtCnt + 1)
        out.write_ns(1, 0); // decode_target_protected_by[0] = ns(chain_cnt): no bits
        out.write(4, 0); // template_chain_fdiff[0][0]: the key frame starts the chain
        out.write(4, 1); // template_chain_fdiff[1][0]: the frame before is in the chain
        // decode_target_layers() reads nothing.
        out.write(1, 0); // resolutions_present_flag
        // frame_dependency_definition() reads nothing without custom flags.
        out.bytes
    }

    /// The descriptors of a frame sent in `packets` packets.
    pub fn for_frame(key: bool, frame_number: u16, packets: usize) -> Vec<DependencyDescriptor> {
        (0..packets)
            .map(|index| DependencyDescriptor {
                start_of_frame: index == 0,
                end_of_frame: index + 1 == packets,
                key,
                frame_number,
                structure: key && index == 0,
            })
            .collect()
    }
}

// ─── IVF (the file source, Q9) ───────────────────────────────────

const IVF_SIGNATURE: &[u8; 4] = b"DKIF";
const IVF_AV1: &[u8; 4] = b"AV01";
const IVF_FRAME_HEADER: usize = 12;

/// The temporal units of an IVF file of AV1: a 32 byte file header (`DKIF`, version, header
/// size, `AV01`, ...), then per frame a 4 byte little-endian size, an 8 byte timestamp and the
/// data.
pub fn ivf_frames(file: &[u8]) -> Result<Vec<&[u8]>, Error> {
    if file.len() < 32 || &file[..4] != IVF_SIGNATURE {
        return Err(Error::invalid("not an IVF file"));
    }
    if &file[8..12] != IVF_AV1 {
        return Err(Error::invalid(format!("IVF of {:?}, not AV01", String::from_utf8_lossy(&file[8..12]))));
    }
    let header = usize::from(u16::from_le_bytes([file[6], file[7]]));
    let mut rest = file.get(header..).ok_or_else(|| Error::invalid("IVF header runs past the end"))?;
    let mut frames = Vec::new();
    while !rest.is_empty() {
        if rest.len() < IVF_FRAME_HEADER {
            return Err(Error::invalid("IVF frame header cut short"));
        }
        let size = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        let data = rest
            .get(IVF_FRAME_HEADER..IVF_FRAME_HEADER + size)
            .ok_or_else(|| Error::invalid("IVF frame runs past the end"))?;
        frames.push(data);
        rest = &rest[IVF_FRAME_HEADER + size..];
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Test readers, written from the format's text, not from the writers above ──

    /// Section 4.4: the aggregation header and the OBU elements of one payload.
    #[derive(Debug, PartialEq)]
    struct Payload {
        z: bool,
        y: bool,
        w: u8,
        n: bool,
        elements: Vec<Vec<u8>>,
        /// Whether each element had a length field before it.
        with_length: Vec<bool>,
    }

    fn read_payload(payload: &[u8]) -> Payload {
        let header = payload[0];
        assert_eq!(header & 0x07, 0, "the three reserved bits are zero");
        let (z, y, w, n) = (header & 0x80 != 0, header & 0x40 != 0, header >> 4 & 0x03, header & 0x08 != 0);
        let mut rest = &payload[1..];
        let mut elements = Vec::new();
        let mut with_length = Vec::new();
        while !rest.is_empty() {
            // With W = 0 every element has a length. Otherwise the W-th, the last, does not.
            let last = w != 0 && elements.len() + 1 == w as usize;
            if last {
                elements.push(rest.to_vec());
                with_length.push(false);
                rest = &[];
            } else {
                let (len, used) = leb128_read(rest).expect("element length");
                let len = len as usize;
                elements.push(rest[used..used + len].to_vec());
                with_length.push(true);
                rest = &rest[used + len..];
            }
        }
        if w != 0 {
            assert_eq!(elements.len(), w as usize, "W is the number of elements");
        }
        Payload { z, y, w, n, elements, with_length }
    }

    /// Rebuilds the temporal unit from a frame's payloads as a receiver does: fragments joined,
    /// every OBU given a size field again.
    fn depacketize(packets: &[Vec<u8>]) -> Vec<(u8, Option<u8>, Vec<u8>)> {
        let mut obus = Vec::new();
        let mut partial: Option<Vec<u8>> = None;
        for (index, packet) in packets.iter().enumerate() {
            let p = read_payload(packet);
            assert_eq!(p.z, partial.is_some(), "Z of packet {index} says whether an OBU continues");
            if p.n {
                assert!(!p.z, "N implies Z = 0");
            }
            let count = p.elements.len();
            for (i, element) in p.elements.into_iter().enumerate() {
                let mut obu = if i == 0 { partial.take().unwrap_or_default() } else { Vec::new() };
                obu.extend_from_slice(&element);
                if i + 1 == count && p.y {
                    partial = Some(obu);
                } else {
                    let header = obu[0];
                    assert_eq!(header & 0x02, 0, "obu_has_size_field is cleared");
                    let (extension, payload) =
                        if header & 0x04 != 0 { (Some(obu[1]), obu[2..].to_vec()) } else { (None, obu[1..].to_vec()) };
                    obus.push((header, extension, payload));
                }
            }
        }
        assert!(partial.is_none(), "the last packet ends an OBU");
        obus
    }

    /// An OBU with a size field.
    fn obu(kind: u8, extension: Option<u8>, len: usize) -> Vec<u8> {
        let mut out = vec![kind << 3 | OBU_HAS_SIZE | if extension.is_some() { OBU_HAS_EXTENSION } else { 0 }];
        out.extend(extension);
        leb128_write(len, &mut out);
        out.extend((0..len).map(|i| (i * 7 + kind as usize) as u8));
        out
    }

    /// An OBU's (header without the size bit, extension, payload) as the receiver gets it.
    fn expected(kind: u8, extension: Option<u8>, len: usize) -> (u8, Option<u8>, Vec<u8>) {
        let full = obu(kind, extension, len);
        let parsed = obus(&full).unwrap()[0];
        (parsed.header & !OBU_HAS_SIZE, parsed.extension, parsed.payload.to_vec())
    }

    #[test]
    fn leb128_round_trips() {
        for value in [0, 1, 127, 128, 300, 16_383, 16_384, 1_000_000] {
            let mut out = Vec::new();
            leb128_write(value, &mut out);
            assert_eq!(out.len(), leb128_len(value));
            assert_eq!(leb128_read(&out), Some((value as u64, out.len())));
        }
        // The AV1 specification's example: 0x80 0x01 is 128. Non-minimal forms are read too.
        assert_eq!(leb128_read(&[0x80, 0x01]), Some((128, 2)));
        assert_eq!(leb128_read(&[0x85, 0x80, 0x80, 0x00]), Some((5, 4)));
        assert_eq!(leb128_read(&[0x80; 9]), None);
    }

    #[test]
    fn obus_with_and_without_size_fields() {
        let mut frame = obu(OBU_SEQUENCE_HEADER, None, 10);
        frame.extend(obu(4, Some(0x28), 3));
        // A last OBU without a size field runs to the end.
        frame.extend([3 << 3, 9, 9, 9]);
        let parsed = obus(&frame).unwrap();
        assert_eq!(parsed.iter().map(Obu::kind).collect::<Vec<_>>(), vec![1, 4, 3]);
        assert_eq!(parsed[1].extension, Some(0x28));
        assert_eq!(parsed[2].payload, &[9, 9, 9]);
        assert!(has_sequence_header(&frame));
        assert!(!has_sequence_header(&obu(3, None, 5)));
        // Cut short, the forbidden bit, a size past the end.
        assert!(obus(&[0x80]).is_err());
        assert!(obus(&[OBU_HAS_SIZE | 3 << 3, 0x80]).is_err());
        assert!(obus(&[OBU_HAS_SIZE | 3 << 3, 5, 1]).is_err());
        assert!(obus(&[OBU_HAS_EXTENSION | 3 << 3]).is_err());
        assert_eq!(obus(&[]).unwrap(), vec![]);
    }

    #[test]
    fn single_packet() {
        // A small inter frame as av1_vaapi makes it: FH TG.
        let frame = [obu(3, None, 12), obu(4, None, 300)].concat();
        let packets = packetize(&frame, false, 1100).unwrap();
        assert_eq!(packets.len(), 1);
        let p = read_payload(&packets[0]);
        // Z 0, Y 0, W 2, N 0.
        assert_eq!(packets[0][0], 0b0010_0000);
        assert_eq!((p.z, p.y, p.w, p.n), (false, false, 2, false));
        assert_eq!(p.with_length, vec![true, false]);
        // 1 + (1 + 13) + 301.
        assert_eq!(packets[0].len(), 316);
        assert_eq!(depacketize(&packets), vec![expected(3, None, 12), expected(4, None, 300)]);
    }

    #[test]
    fn several_obus_and_the_w_field() {
        // A key frame: SEQ FH TG, N set, W 3.
        let frame = [obu(1, None, 11), obu(3, None, 20), obu(4, None, 500)].concat();
        let packets = packetize(&frame, true, 1100).unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0][0], 0b0011_1000);
        let p = read_payload(&packets[0]);
        assert_eq!(p.with_length, vec![true, true, false]);

        // Four or more elements: W 0 and every element has a length.
        let frame = [obu(1, None, 11), obu(5, None, 4), obu(3, None, 20), obu(4, None, 50)].concat();
        let packets = packetize(&frame, true, 1100).unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0][0], 0b0000_1000);
        let p = read_payload(&packets[0]);
        assert_eq!(p.with_length, vec![true; 4]);
        assert_eq!(depacketize(&packets).len(), 4);

        // An extension header stays with its OBU.
        let frame = [obu(3, Some(0x30), 5), obu(4, Some(0x30), 6)].concat();
        let packets = packetize(&frame, false, 1100).unwrap();
        assert_eq!(depacketize(&packets), vec![expected(3, Some(0x30), 5), expected(4, Some(0x30), 6)]);
    }

    #[test]
    fn temporal_delimiters_and_tile_lists_are_left_out() {
        let frame = [obu(OBU_TEMPORAL_DELIMITER, None, 0), obu(1, None, 9), obu(6, None, 40), obu(OBU_TILE_LIST, None, 3)].concat();
        let packets = packetize(&frame, true, 1100).unwrap();
        assert_eq!(depacketize(&packets), vec![expected(1, None, 9), expected(6, None, 40)]);
        // Nothing but a delimiter: nothing to send.
        assert!(packetize(&obu(OBU_TEMPORAL_DELIMITER, None, 0), false, 1100).unwrap().is_empty());
    }

    #[test]
    fn fragments_and_their_bits() {
        // A 3000 byte tile group after a frame header.
        let frame = [obu(3, None, 10), obu(4, None, 3000)].concat();
        let packets = packetize(&frame, false, 1100).unwrap();
        assert!(packets.iter().all(|p| p.len() <= 1100));
        assert_eq!(packets.len(), 3);
        let parsed: Vec<Payload> = packets.iter().map(|p| read_payload(p)).collect();
        // First: FH whole and the start of TG, Y. Middle: Z and Y, one element. Last: Z only.
        assert_eq!((parsed[0].z, parsed[0].y, parsed[0].w), (false, true, 2));
        assert_eq!((parsed[1].z, parsed[1].y, parsed[1].w), (true, true, 1));
        assert_eq!((parsed[2].z, parsed[2].y, parsed[2].w), (true, false, 1));
        // The first two are full.
        assert_eq!(packets[0].len(), 1100);
        assert_eq!(packets[1].len(), 1100);
        assert_eq!(depacketize(&packets), vec![expected(3, None, 10), expected(4, None, 3000)]);

        // A key frame's N is on its first packet only.
        let frame = [obu(1, None, 11), obu(3, None, 10), obu(4, None, 5000)].concat();
        let packets = packetize(&frame, true, 1100).unwrap();
        let n: Vec<bool> = packets.iter().map(|p| read_payload(p).n).collect();
        assert_eq!(n[0], true);
        assert!(n[1..].iter().all(|n| !n));
    }

    #[test]
    fn sizes_at_the_limit() {
        // One element of exactly limit - 1 bytes fills a packet; one more byte needs two.
        let frame = obu(3, None, 1098);
        let packets = packetize(&frame, false, 1100).unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].len(), 1100);
        let frame = obu(3, None, 1099);
        let packets = packetize(&frame, false, 1100).unwrap();
        assert_eq!(packets.len(), 2);
        assert_eq!(packets[0].len(), 1100);
        assert_eq!(read_payload(&packets[1]).elements[0].len(), 1);
        // An element that would only fit without room for its length field starts the next
        // packet rather than leave an empty one.
        for limit in [4, 5, 7, 64, 129, 130, 131, 1100] {
            for frame in [
                [obu(3, None, 1), obu(4, None, 126)].concat(),
                [obu(3, None, 125), obu(4, None, 126), obu(6, None, 2)].concat(),
                (0..9).map(|i| obu(5, None, i * 30)).collect::<Vec<_>>().concat(),
            ] {
                let packets = packetize(&frame, true, limit).unwrap();
                assert!(packets.iter().all(|p| p.len() <= limit && p.len() > 1), "limit {limit}");
                let want: Vec<_> = obus(&frame).unwrap().iter().map(|o| (o.header & !OBU_HAS_SIZE, o.extension, o.payload.to_vec())).collect();
                assert_eq!(depacketize(&packets), want, "limit {limit}");
            }
        }
        assert!(packetize(&obu(3, None, 5), false, 3).is_err());
    }

    #[test]
    fn round_trip_through_e2ee_shaped_frames() {
        // Sizes like the encoder's: the size fields at fixed widths (SEQ 2 bytes, TG 4), and frames
        // without a size on the last OBU, as the E2EE format allows.
        let mut fixed = vec![1 << 3 | OBU_HAS_SIZE, 0x8b, 0x00];
        fixed.extend((0..11).map(|i| i as u8));
        fixed.extend([4 << 3 | OBU_HAS_SIZE, 0xe8, 0x87, 0x80, 0x00]);
        fixed.extend((0..1000).map(|i| (i % 251) as u8));
        let packets = packetize(&fixed, true, 1100).unwrap();
        let got = depacketize(&packets);
        assert_eq!(got.iter().map(|o| (o.0, o.2.len())).collect::<Vec<_>>(), vec![(1 << 3, 11), (4 << 3, 1000)]);
        assert_eq!(got[0].2, (0..11).collect::<Vec<u8>>());
        assert_eq!(got[1].2, (0..1000).map(|i| (i % 251) as u8).collect::<Vec<u8>>());

        let mut unsized_last = obu(3, None, 30);
        unsized_last.push(4 << 3);
        unsized_last.extend((0..2500).map(|i| (i % 13) as u8));
        let got = depacketize(&packetize(&unsized_last, false, 1100).unwrap());
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].2.len(), 2500);
    }

    // ── The Dependency Descriptor ──

    /// A.8.2's `f(n)` and `ns(n)` over the descriptor's bytes.
    struct BitReader<'a> {
        data: &'a [u8],
        at: usize,
    }

    impl BitReader<'_> {
        fn f(&mut self, n: usize) -> u64 {
            let mut x = 0;
            for _ in 0..n {
                let bit = self.data[self.at / 8] >> (7 - self.at % 8) & 1;
                x = 2 * x + u64::from(bit);
                self.at += 1;
            }
            x
        }

        fn ns(&mut self, n: u64) -> u64 {
            let mut w = 0;
            let mut x = n;
            while x != 0 {
                x >>= 1;
                w += 1;
            }
            let m = (1 << w) - n;
            let v = self.f(w - 1);
            if v < m {
                return v;
            }
            let extra_bit = self.f(1);
            (v << 1) - m + extra_bit
        }
    }

    /// The template dependency structure as A.8.2 reads it.
    #[derive(Clone, Debug, Default, PartialEq)]
    struct Structure {
        template_id_offset: u64,
        dt_cnt: u64,
        /// (spatial id, temporal id) of each template.
        layers: Vec<(u64, u64)>,
        dtis: Vec<Vec<u64>>,
        fdiffs: Vec<Vec<u64>>,
        chain_cnt: u64,
        protected_by: Vec<u64>,
        chain_fdiffs: Vec<Vec<u64>>,
        resolutions: Option<Vec<(u64, u64)>>,
    }

    /// One descriptor as A.8.2 reads it, with the frame's values from its template.
    #[derive(Debug, PartialEq)]
    struct Read {
        start_of_frame: bool,
        end_of_frame: bool,
        template_id: u64,
        frame_number: u64,
        structure_attached: bool,
        active_decode_targets: Option<u64>,
        spatial_id: u64,
        temporal_id: u64,
        frame_dti: Vec<u64>,
        frame_fdiffs: Vec<u64>,
        frame_chain_fdiffs: Vec<u64>,
    }

    /// `dependency_descriptor(sz)`, keeping the structure across packets in `known`.
    fn read_descriptor(data: &[u8], known: &mut Option<Structure>) -> Read {
        let sz = data.len();
        let mut r = BitReader { data, at: 0 };
        // mandatory_descriptor_fields()
        let start_of_frame = r.f(1) == 1;
        let end_of_frame = r.f(1) == 1;
        let template_id = r.f(6);
        let frame_number = r.f(16);
        let (mut custom_dtis, mut custom_fdiffs, mut custom_chains) = (false, false, false);
        let mut structure_attached = false;
        let mut active_decode_targets = None;
        if sz > 3 {
            // extended_descriptor_fields()
            let structure_present = r.f(1) == 1;
            let active_present = r.f(1) == 1;
            custom_dtis = r.f(1) == 1;
            custom_fdiffs = r.f(1) == 1;
            custom_chains = r.f(1) == 1;
            if structure_present {
                structure_attached = true;
                let mut s = Structure { template_id_offset: r.f(6), dt_cnt: r.f(5) + 1, ..Structure::default() };
                // template_layers()
                let (mut spatial, mut temporal) = (0, 0);
                loop {
                    s.layers.push((spatial, temporal));
                    match r.f(2) {
                        0 => {}
                        1 => temporal += 1,
                        2 => {
                            temporal = 0;
                            spatial += 1;
                        }
                        _ => break,
                    }
                }
                // template_dtis()
                for _ in 0..s.layers.len() {
                    s.dtis.push((0..s.dt_cnt).map(|_| r.f(2)).collect());
                }
                // template_fdiffs()
                for _ in 0..s.layers.len() {
                    let mut fdiffs = Vec::new();
                    while r.f(1) == 1 {
                        fdiffs.push(r.f(4) + 1);
                    }
                    s.fdiffs.push(fdiffs);
                }
                // template_chains()
                s.chain_cnt = r.ns(s.dt_cnt + 1);
                if s.chain_cnt != 0 {
                    s.protected_by = (0..s.dt_cnt).map(|_| r.ns(s.chain_cnt)).collect();
                    for _ in 0..s.layers.len() {
                        s.chain_fdiffs.push((0..s.chain_cnt).map(|_| r.f(4)).collect());
                    }
                }
                // decode_target_layers() reads nothing. resolutions_present_flag:
                if r.f(1) == 1 {
                    let max_spatial = s.layers.iter().map(|l| l.0).max().unwrap_or(0);
                    s.resolutions = Some((0..=max_spatial).map(|_| (r.f(16) + 1, r.f(16) + 1)).collect());
                }
                active_decode_targets = Some((1 << s.dt_cnt) - 1);
                *known = Some(s);
            }
            if active_present {
                active_decode_targets = Some(r.f(known.as_ref().unwrap().dt_cnt as usize));
            }
        }
        // frame_dependency_definition()
        let s = known.as_ref().expect("a structure before any frame");
        let index = ((template_id + 64 - s.template_id_offset) % 64) as usize;
        assert!(index < s.layers.len(), "template id {template_id} out of range");
        let frame_dti = if custom_dtis { (0..s.dt_cnt).map(|_| r.f(2)).collect() } else { s.dtis[index].clone() };
        let frame_fdiffs = if custom_fdiffs {
            let mut fdiffs = Vec::new();
            loop {
                let size = r.f(2) as usize;
                if size == 0 {
                    break;
                }
                fdiffs.push(r.f(4 * size) + 1);
            }
            fdiffs
        } else {
            s.fdiffs[index].clone()
        };
        let frame_chain_fdiffs =
            if custom_chains { (0..s.chain_cnt).map(|_| r.f(8)).collect() } else { s.chain_fdiffs.get(index).cloned().unwrap_or_default() };
        // zero_padding = f(sz * 8 - TotalConsumedBits)
        let padding = sz * 8 - r.at;
        assert!(padding < 8, "{padding} bits of padding");
        assert_eq!(r.f(padding), 0, "zero_padding is zero");
        Read {
            start_of_frame,
            end_of_frame,
            template_id,
            frame_number,
            structure_attached,
            active_decode_targets,
            spatial_id: s.layers[index].0,
            temporal_id: s.layers[index].1,
            frame_dti,
            frame_fdiffs,
            frame_chain_fdiffs,
        }
    }

    #[test]
    fn the_key_frame_structure_bit_by_bit() {
        let first = DependencyDescriptor { start_of_frame: true, end_of_frame: false, key: true, frame_number: 0x1234, structure: true };
        // Written out by hand from A.8.2, field by field.
        let bits = concat!(
            "1", "0", "000000", "0001001000110100", // start, end, template id 0, frame number
            "1", "0", "0", "0", "0",                 // structure present, no bitmask, no custom fields
            "000000", "00000",                        // template_id_offset 0, dt_cnt_minus_one 0
            "00", "11",                               // next_layer_idc: same layer, then the end
            "10", "10",                               // DTI Switch, Switch
            "0", "1", "0000", "0",                    // no fdiffs; one fdiff of 1
            "1",                                      // chain_cnt = ns(2) = 1, protected_by = ns(1): no bits
            "0000", "0001",                           // chain fdiffs 0 and 1
            "0",                                      // no resolutions
            "0000000",                                // zero padding
        );
        let expected: Vec<u8> = bits.as_bytes().chunks(8).map(|byte| byte.iter().fold(0, |v, b| v << 1 | (b - b'0'))).collect();
        assert_eq!(expected.len(), 9);
        assert_eq!(first.to_bytes(), expected);
    }

    #[test]
    fn mandatory_fields_alone_are_three_bytes() {
        let d = DependencyDescriptor { start_of_frame: false, end_of_frame: true, key: false, frame_number: 0xfffe, structure: false };
        // 0, 1, template 1, 0xfffe.
        assert_eq!(d.to_bytes(), vec![0b0100_0001, 0xff, 0xfe]);
        let k = DependencyDescriptor { key: true, start_of_frame: true, ..d };
        assert_eq!(k.to_bytes(), vec![0b1100_0000, 0xff, 0xfe]);
    }

    #[test]
    fn a_reader_from_the_syntax_reads_back_both_templates() {
        let mut known = None;
        // A key frame in three packets, then an inter frame in two, then a one packet inter frame.
        let mut frames = vec![(true, 41u16, 3usize), (false, 42, 2), (false, 43, 1)];
        // And frame numbers across the wrap.
        frames.extend([(false, 65535, 1), (false, 0, 1), (true, 1, 1), (false, 2, 1)]);
        for (key, number, packets) in frames {
            let descriptors = DependencyDescriptor::for_frame(key, number, packets);
            for (index, d) in descriptors.iter().enumerate() {
                let bytes = d.to_bytes();
                assert!(bytes.len() <= 16, "fits the one-byte header form");
                let read = read_descriptor(&bytes, &mut known);
                assert_eq!(read.start_of_frame, index == 0);
                assert_eq!(read.end_of_frame, index + 1 == packets);
                assert_eq!(read.frame_number, u64::from(number));
                assert_eq!(read.structure_attached, key && index == 0);
                assert_eq!(read.template_id, if key { 0 } else { 1 });
                assert_eq!((read.spatial_id, read.temporal_id), (0, 0));
                assert_eq!(read.frame_dti, vec![2], "Switch");
                if key {
                    assert_eq!(read.frame_fdiffs, Vec::<u64>::new(), "a key frame depends on nothing");
                    assert_eq!(read.frame_chain_fdiffs, vec![0], "and starts the chain");
                } else {
                    assert_eq!(read.frame_fdiffs, vec![1], "the frame before");
                    assert_eq!(read.frame_chain_fdiffs, vec![1]);
                }
                if read.structure_attached {
                    assert_eq!(read.active_decode_targets, Some(1));
                    assert_eq!(bytes.len(), 9);
                } else {
                    assert_eq!(read.active_decode_targets, None);
                    assert_eq!(bytes.len(), 3);
                }
            }
        }
        let s = known.unwrap();
        assert_eq!(
            s,
            Structure {
                template_id_offset: 0,
                dt_cnt: 1,
                layers: vec![(0, 0), (0, 0)],
                dtis: vec![vec![2], vec![2]],
                fdiffs: vec![vec![], vec![1]],
                chain_cnt: 1,
                protected_by: vec![0],
                chain_fdiffs: vec![vec![0], vec![1]],
                resolutions: None,
            }
        );
    }

    #[test]
    fn write_ns_matches_the_specification_table() {
        // A.8.2's table for n = 5: 00, 01, 10, 110, 111.
        for (v, bits) in [(0, "00"), (1, "01"), (2, "10"), (3, "110"), (4, "111")] {
            let mut w = BitWriter::default();
            w.write_ns(5, v);
            assert_eq!(w.bits, bits.len(), "{v}");
            let read: String = (0..w.bits).map(|i| if w.bytes[i / 8] >> (7 - i % 8) & 1 == 1 { '1' } else { '0' }).collect();
            assert_eq!(read, bits);
            let mut r = BitReader { data: &w.bytes, at: 0 };
            assert_eq!(r.ns(5), v);
        }
        let mut w = BitWriter::default();
        w.write_ns(1, 0);
        assert_eq!(w.bits, 0);
    }

    // ── IVF ──

    fn ivf(frames: &[&[u8]]) -> Vec<u8> {
        let mut out = b"DKIF".to_vec();
        out.extend(0u16.to_le_bytes());
        out.extend(32u16.to_le_bytes());
        out.extend(b"AV01");
        out.extend(1280u16.to_le_bytes());
        out.extend(720u16.to_le_bytes());
        out.extend(30u32.to_le_bytes());
        out.extend(1u32.to_le_bytes());
        out.extend((frames.len() as u32).to_le_bytes());
        out.extend(0u32.to_le_bytes());
        for (pts, frame) in frames.iter().enumerate() {
            out.extend((frame.len() as u32).to_le_bytes());
            out.extend((pts as u64).to_le_bytes());
            out.extend_from_slice(frame);
        }
        out
    }

    #[test]
    fn ivf_frames_are_read() {
        let key = [obu(2, None, 0), obu(1, None, 10), obu(6, None, 100)].concat();
        let delta = [obu(2, None, 0), obu(6, None, 20)].concat();
        let file = ivf(&[&key, &delta, &delta]);
        let frames = ivf_frames(&file).unwrap();
        assert_eq!(frames, vec![&key[..], &delta[..], &delta[..]]);
        assert!(has_sequence_header(frames[0]) && !has_sequence_header(frames[1]));

        assert!(ivf_frames(b"DKIF").is_err());
        let mut vp9 = file.clone();
        vp9[8..12].copy_from_slice(b"VP90");
        assert!(ivf_frames(&vp9).is_err());
        assert!(ivf_frames(&file[..file.len() - 1]).is_err());
        assert!(ivf_frames(&file[..40]).is_err());
        assert_eq!(ivf_frames(&ivf(&[])).unwrap().len(), 0);
    }
}
