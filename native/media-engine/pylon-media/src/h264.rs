// H264: an Annex-B stream split into access units, and an RTP packetizer that does what
// libwebrtc's RtpPacketizerH264 does in non-interleaved mode (RFC 6184, packetization-mode 1)
// with no header-extension reductions.

/// The engine's RTP payload limit.
pub const PAYLOAD_LIMIT: usize = 1100;

const STAP_A: u8 = 24;
const FU_A: u8 = 28;
const NAL_HEADER: usize = 1;
const LENGTH_FIELD: usize = 2;
const FU_A_HEADER: usize = 2;
const F_NRI: u8 = 0xE0;
const TYPE: u8 = 0x1F;

/// The type of a NAL unit, from its header.
pub fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |header| header & TYPE)
}

/// Start codes of an Annex-B buffer as (start code begins, payload begins).
fn start_codes(data: &[u8]) -> Vec<(usize, usize)> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            // A 4-byte start code's leading zero belongs to the start code, as in libwebrtc's
            // H264::FindNaluIndices.
            let begin = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
            starts.push((begin, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
}

/// NAL unit payloads of an Annex-B buffer, without start codes. Empty units are left out.
pub fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let starts = start_codes(data);
    starts
        .iter()
        .enumerate()
        .map(|(n, &(_, payload))| {
            let end = starts.get(n + 1).map_or(data.len(), |&(begin, _)| begin);
            &data[payload..end.max(payload)]
        })
        .filter(|nal| !nal.is_empty())
        .collect()
}

/// Access units of an Annex-B stream, as the original bytes with their start codes. An access
/// unit ends with its slice NAL (type 1 or 5). NALs after the last slice are left out.
pub fn access_units(stream: &[u8]) -> Vec<&[u8]> {
    let starts = start_codes(stream);
    let mut units = Vec::new();
    let mut first = None;
    for (n, &(begin, payload)) in starts.iter().enumerate() {
        let end = starts.get(n + 1).map_or(stream.len(), |&(next, _)| next);
        let au_begin = *first.get_or_insert(begin);
        if payload < end && matches!(stream[payload] & TYPE, 1 | 5) {
            units.push(&stream[au_begin..end]);
            first = None;
        }
    }
    units
}

/// RTP payloads for one frame, the way libwebrtc packetizes it.
pub fn packetize(frame: &[u8], limit: usize) -> Vec<Vec<u8>> {
    let nals = nal_units(frame);
    let mut packets = Vec::new();
    let mut i = 0;
    while i < nals.len() {
        if nals[i].len() > limit {
            fu_a(nals[i], limit, &mut packets);
            i += 1;
        } else {
            i = stap_a(&nals, i, limit, &mut packets);
        }
    }
    packets
}

/// Aggregates the NALs from `index` on that fit together. A lone one goes out as itself.
/// Returns the index of the first NAL not taken.
fn stap_a(nals: &[&[u8]], index: usize, limit: usize, packets: &mut Vec<Vec<u8>>) -> usize {
    let mut left = limit;
    let mut headers = 0;
    let mut end = index;
    // As libwebrtc: the first NAL is checked without the STAP-A header and its length field,
    // which are only charged once a second NAL is considered.
    while end < nals.len() && left >= nals[end].len() + headers {
        left -= nals[end].len() + headers;
        headers = if end == index {
            LENGTH_FIELD + NAL_HEADER + LENGTH_FIELD
        } else {
            LENGTH_FIELD
        };
        end += 1;
    }

    if end - index == 1 {
        packets.push(nals[index].to_vec());
    } else {
        let mut packet = vec![(nals[index][0] & F_NRI) | STAP_A];
        for nal in &nals[index..end] {
            packet.extend_from_slice(&(nal.len() as u16).to_be_bytes());
            packet.extend_from_slice(nal);
        }
        packets.push(packet);
    }
    end
}

/// Splits one NAL into FU-A fragments of about equal size.
fn fu_a(nal: &[u8], limit: usize, packets: &mut Vec<Vec<u8>>) {
    let header = nal[0];
    let body = &nal[NAL_HEADER..];
    let capacity = limit - FU_A_HEADER;
    let count = body.len().div_ceil(capacity);
    // libwebrtc's SplitAboutEqually: the last `larger` fragments are one byte longer.
    let size = body.len() / count;
    let larger = body.len() % count;

    let mut offset = 0;
    for n in 0..count {
        let len = size + usize::from(n >= count - larger);
        let mut fu_header = header & TYPE;
        if n == 0 {
            fu_header |= 0x80;
        }
        if n == count - 1 {
            fu_header |= 0x40;
        }
        let mut packet = Vec::with_capacity(FU_A_HEADER + len);
        packet.push((header & F_NRI) | FU_A);
        packet.push(fu_header);
        packet.extend_from_slice(&body[offset..offset + len]);
        packets.push(packet);
        offset += len;
    }
}

/// What kind of RTP payload this is: "single", "STAP-A" or "FU-A".
pub fn packet_kind(payload: &[u8]) -> &'static str {
    match nal_type(payload) {
        STAP_A => "STAP-A",
        FU_A => "FU-A",
        _ => "single",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rebuilds the NAL units from a frame's RTP payloads, as a receiver would.
    fn depacketize(packets: &[Vec<u8>]) -> Vec<Vec<u8>> {
        let mut nals = Vec::new();
        let mut fragment: Option<Vec<u8>> = None;
        for packet in packets {
            match nal_type(packet) {
                STAP_A => {
                    let mut rest = &packet[1..];
                    while !rest.is_empty() {
                        let len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
                        nals.push(rest[2..2 + len].to_vec());
                        rest = &rest[2 + len..];
                    }
                }
                FU_A => {
                    let (indicator, fu) = (packet[0], packet[1]);
                    if fu & 0x80 != 0 {
                        assert!(fragment.is_none(), "FU-A start inside a fragment");
                        fragment = Some(vec![(indicator & F_NRI) | (fu & TYPE)]);
                    }
                    let nal = fragment.as_mut().expect("FU-A without a start");
                    nal.extend_from_slice(&packet[2..]);
                    if fu & 0x40 != 0 {
                        nals.push(fragment.take().unwrap());
                    }
                }
                _ => nals.push(packet.clone()),
            }
        }
        assert!(fragment.is_none(), "FU-A without an end");
        nals
    }

    fn nal(header: u8, len: usize) -> Vec<u8> {
        let mut nal = vec![header];
        nal.extend((1..len).map(|i| (i % 251) as u8 + 1));
        nal
    }

    fn annex_b(nals: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, nal) in nals.iter().enumerate() {
            out.extend_from_slice(if i % 2 == 0 { &[0, 0, 0, 1][..] } else { &[0, 0, 1][..] });
            out.extend_from_slice(nal);
        }
        out
    }

    #[test]
    fn splits_on_3_and_4_byte_start_codes() {
        let data = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5];
        let units = nal_units(&data);
        assert_eq!(units, vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]);
    }

    #[test]
    fn access_units_end_with_their_slice() {
        let nals = [nal(0x67, 10), nal(0x68, 4), nal(0x06, 20), nal(0x65, 50), nal(0x41, 30), nal(0x41, 30)];
        let stream = annex_b(&nals);
        let units = access_units(&stream);
        assert_eq!(units.len(), 3);
        let types: Vec<Vec<u8>> = units.iter().map(|u| nal_units(u).iter().map(|n| nal_type(n)).collect()).collect();
        assert_eq!(types, vec![vec![7, 8, 6, 5], vec![1], vec![1]]);
        assert_eq!(units.concat(), stream);
    }

    #[test]
    fn single_nal_unit_packet() {
        let n = nal(0x41, 500);
        let packets = packetize(&annex_b(&[n.clone()]), PAYLOAD_LIMIT);
        assert_eq!(packets, vec![n]);
    }

    #[test]
    fn stap_a_aggregates_parameter_sets() {
        let (sps, pps, idr) = (nal(0x67, 10), nal(0x68, 4), nal(0x65, 2000));
        let packets = packetize(&annex_b(&[sps.clone(), pps.clone(), idr]), PAYLOAD_LIMIT);
        assert_eq!(packet_kind(&packets[0]), "STAP-A");
        assert_eq!(packets[0][0], 0x78);
        let mut expected = vec![0x78, 0, 10];
        expected.extend_from_slice(&sps);
        expected.extend_from_slice(&[0, 4]);
        expected.extend_from_slice(&pps);
        assert_eq!(packets[0], expected);
        assert!(packets[1..].iter().all(|p| packet_kind(p) == "FU-A"));
    }

    #[test]
    fn fu_a_start_and_end_bits() {
        let n = nal(0x65, 3000);
        let packets = packetize(&annex_b(&[n]), PAYLOAD_LIMIT);
        assert_eq!(packets.len(), 3);
        for (i, p) in packets.iter().enumerate() {
            assert_eq!(p[0], 0x60 | FU_A);
            assert_eq!(p[1] & TYPE, 5);
            assert_eq!(p[1] & 0x80 != 0, i == 0);
            assert_eq!(p[1] & 0x40 != 0, i == 2);
            assert_eq!(p[1] & 0x20, 0);
        }
        // 2999 body bytes over 3 fragments: 999, then two of 1000.
        let sizes: Vec<usize> = packets.iter().map(|p| p.len() - 2).collect();
        assert_eq!(sizes, vec![999, 1000, 1000]);
    }

    #[test]
    fn sizes_at_the_limit() {
        // A NAL of exactly the limit is one packet, one byte more is two fragments.
        let packets = packetize(&annex_b(&[nal(0x41, 1100)]), PAYLOAD_LIMIT);
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].len(), 1100);
        let packets = packetize(&annex_b(&[nal(0x41, 1101)]), PAYLOAD_LIMIT);
        assert_eq!(packets.len(), 2);
        assert!(packets.iter().all(|p| packet_kind(p) == "FU-A" && p.len() <= 1100));

        // A STAP-A that fills the limit exactly: 1 + 2 + 500 + 2 + 595.
        let packets = packetize(&annex_b(&[nal(0x06, 500), nal(0x41, 595)]), PAYLOAD_LIMIT);
        assert_eq!(packets.len(), 1);
        assert_eq!(packet_kind(&packets[0]), "STAP-A");
        assert_eq!(packets[0].len(), 1100);
        // One byte more and they go out alone.
        let packets = packetize(&annex_b(&[nal(0x06, 500), nal(0x41, 596)]), PAYLOAD_LIMIT);
        assert_eq!(packets.iter().map(|p| packet_kind(p)).collect::<Vec<_>>(), vec!["single", "single"]);
        assert_eq!(packets[1].len(), 596);
    }

    #[test]
    fn round_trip() {
        let frames = [
            vec![nal(0x67, 12), nal(0x68, 4), nal(0x06, 700), nal(0x65, 45_000)],
            vec![nal(0x41, 300)],
            vec![nal(0x41, 1100), nal(0x41, 1), nal(0x41, 2), nal(0x41, 2200)],
            vec![nal(0x09, 2), nal(0x67, 12), nal(0x68, 4), nal(0x65, 1099)],
            (1..40).map(|i| nal(0x41, i * 37)).collect(),
        ];
        for nals in frames {
            let packets = packetize(&annex_b(&nals), PAYLOAD_LIMIT);
            assert!(packets.iter().all(|p| p.len() <= PAYLOAD_LIMIT));
            assert_eq!(depacketize(&packets), nals);
        }
    }
}
