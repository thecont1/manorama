#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FilenameSignal {
    Named {
        folder: String,
        year_month: u16,
        label: String,
    },
    Sequence {
        folder: String,
        prefix: String,
    },
}

pub(crate) fn signal(id: &str) -> Option<FilenameSignal> {
    let normalized = id.replace('\\', "/");
    let (folder, filename) = normalized
        .rsplit_once('/')
        .unwrap_or(("", normalized.as_str()));
    let (stem, _) = filename.rsplit_once('.')?;
    let mut bytes = stem.as_bytes().to_vec();
    strip_enhanced_suffix(&mut bytes);
    if bytes.is_empty() {
        return None;
    }

    if let Some(named) = named_signal(folder, &bytes) {
        return Some(named);
    }
    sequence_signal(folder, &bytes)
}

pub(crate) fn sequence_number(id: &str) -> Option<u64> {
    let normalized = id.replace('\\', "/");
    let filename = normalized.rsplit('/').next().unwrap_or(&normalized);
    let (stem, _) = filename.rsplit_once('.')?;
    let mut bytes = stem.as_bytes().to_vec();
    strip_enhanced_suffix(&mut bytes);
    let start = trailing_digits(&bytes)?.0;
    parse_u64(&bytes[start..])
}

fn named_signal(folder: &str, bytes: &[u8]) -> Option<FilenameSignal> {
    if bytes.len() < 10 || !bytes[..2].eq_ignore_ascii_case(b"MS") {
        return None;
    }
    let year_month = parse_u64(bytes.get(2..8)?)?;
    let year = year_month / 100;
    let month = year_month % 100;
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    if !matches!(bytes[8], b'-' | b'_') {
        return None;
    }
    let start = trailing_digits(bytes.get(9..)?)?.0 + 9;
    parse_u64(bytes.get(start..)?)?;
    let mut label = bytes.get(9..start)?.to_vec();
    while label
        .last()
        .is_some_and(|byte| matches!(*byte, b'-' | b'_' | b' '))
    {
        label.pop();
    }
    if label.is_empty()
        || label
            .iter()
            .filter(|byte| byte.is_ascii_alphabetic())
            .count()
            < 3
        || !label.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b' ' | b'.' | b'\'')
        })
    {
        return None;
    }
    Some(FilenameSignal::Named {
        folder: folder.to_owned(),
        year_month: year_month as u16,
        label: ascii_lower(&label),
    })
}

fn sequence_signal(folder: &str, bytes: &[u8]) -> Option<FilenameSignal> {
    let (start, digits) = trailing_digits(bytes)?;
    parse_u64(bytes.get(start..)?)?;
    let mut prefix = bytes.get(..start)?.to_vec();
    while prefix
        .last()
        .is_some_and(|byte| matches!(*byte, b'-' | b'_' | b' '))
    {
        prefix.pop();
    }
    if prefix
        .iter()
        .filter(|byte| byte.is_ascii_alphabetic())
        .count()
        < 3
        || !prefix
            .iter()
            .all(|byte| byte.is_ascii_alphabetic() || matches!(*byte, b'-' | b'_'))
    {
        return None;
    }
    let prefix = ascii_lower(&prefix);
    if prefix == "img" && digits == 14 {
        return None;
    }
    Some(FilenameSignal::Sequence {
        folder: folder.to_owned(),
        prefix,
    })
}

fn trailing_digits(bytes: &[u8]) -> Option<(usize, usize)> {
    if bytes.last().is_none_or(|byte| !byte.is_ascii_digit()) {
        return None;
    }
    let mut start = bytes.len();
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    Some((start, bytes.len() - start))
}

fn strip_enhanced_suffix(bytes: &mut Vec<u8>) {
    const SUFFIX: &[u8] = b"-enhanced-nr";
    while bytes.len() >= SUFFIX.len()
        && bytes[bytes.len() - SUFFIX.len()..].eq_ignore_ascii_case(SUFFIX)
    {
        bytes.truncate(bytes.len() - SUFFIX.len());
    }
}

fn parse_u64(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0_u64, |value, byte| {
        value.checked_mul(10)?.checked_add(u64::from(byte - b'0'))
    })
}

fn ascii_lower(bytes: &[u8]) -> String {
    String::from_utf8(bytes.iter().map(|byte| byte.to_ascii_lowercase()).collect()).unwrap()
}
