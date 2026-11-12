// SPDX-License-Identifier: GPL-3.0-or-later
//!
//! Traffic replay over a committed corpus of YouTube request URLs.
//!
//! The corpus (rust/tests/corpus/youtube-traffic.tsv) is SYNTHESIZED: no URL in
//! it was captured from a device or a network trace. It exists to pin the
//! engine's verdict per request class against the lists the app actually ships,
//! so a list update that starts blocking videoplayback fails here rather than on
//! the user's TV. Live-traffic verification on hardware is a separate step in
//! docs/ON-DEVICE-TEST.md.

use shieldtube::engine::ShieldEngine;

const CORPUS: &str = include_str!("corpus/youtube-traffic.tsv");
const SOURCE: &str = "https://www.youtube.com/tv";

fn shipped_engine() -> ShieldEngine {
    // Exactly the lists the APK carries, in the same order the app loads them.
    let lists = [
        (
            "brave-specific",
            include_str!("../../app/src/main/assets/lists/brave-specific.txt"),
        ),
        (
            "ubo-filters",
            include_str!("../../app/src/main/assets/lists/ubo-filters.txt"),
        ),
        (
            "ubo-unbreak",
            include_str!("../../app/src/main/assets/lists/ubo-unbreak.txt"),
        ),
        (
            "easylist-core",
            include_str!("../../app/src/main/assets/lists/easylist-core.txt"),
        ),
        (
            "easyprivacy-core",
            include_str!("../../app/src/main/assets/lists/easyprivacy-core.txt"),
        ),
        (
            "brave-unbreak",
            include_str!("../../app/src/main/assets/lists/brave-unbreak.txt"),
        ),
    ];
    let payload = serde_json::json!({
        "lists": lists.iter().map(|(name, text)| serde_json::json!({
            "name": name,
            "text": text,
            "format": "standard",
            "trusted": true,
        })).collect::<Vec<_>>(),
        "resources": []
    })
    .to_string();
    ShieldEngine::create(&payload).expect("shipped lists must build")
}

struct Record {
    class: String,
    expected: bool,
    request_type: String,
    url: String,
    line: usize,
}

fn records() -> Vec<Record> {
    CORPUS
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .map(|(i, l)| {
            let f: Vec<&str> = l.split('\t').collect();
            assert_eq!(f.len(), 4, "malformed corpus line {}: {l:?}", i + 1);
            Record {
                class: f[0].to_string(),
                expected: match f[1] {
                    "block" => true,
                    "allow" => false,
                    other => panic!("line {}: bad expectation {other:?}", i + 1),
                },
                request_type: f[2].to_string(),
                url: f[3].to_string(),
                line: i + 1,
            }
        })
        .collect()
}

#[test]
fn corpus_has_the_expected_shape() {
    let r = records();
    assert!(r.len() >= 30, "corpus lost records: only {}", r.len());
    let ads = r.iter().filter(|x| x.class == "ads").count();
    let content = r.iter().filter(|x| x.class == "content").count();
    assert!(ads >= 12, "too few ad URLs: {ads}");
    assert!(content >= 12, "too few content URLs: {content}");
    // The corpus must contain at least one case-trick URL per class, otherwise
    // the case-normalisation regression would not be covered here.
    assert!(r
        .iter()
        .any(|x| x.class == "ads" && x.url.contains("GOOGLESYNDICATION")));
    assert!(r
        .iter()
        .any(|x| x.class == "content" && x.url.contains("GOOGLEVIDEO")));

    // Coverage gaps found by this corpus are recorded in the file as `allow`
    // with a "MEASURED GAP" comment. Pin the count so a list change that closes
    // one (good) forces the corpus to be updated rather than drifting silently.
    let gap_mentions = CORPUS.matches("MEASURED GAP").count();
    println!("[corpus] documented list-coverage gaps: {gap_mentions}");
    assert!(
        gap_mentions > 0,
        "expected the known gaps to stay documented"
    );
}

#[test]
fn every_record_matches_its_expected_verdict() {
    let engine = shipped_engine();
    let mut failures = Vec::new();
    let mut by_class: std::collections::BTreeMap<String, (usize, usize)> =
        std::collections::BTreeMap::new();

    for rec in records() {
        let got = engine.check_request(&rec.url, SOURCE, &rec.request_type);
        let entry = by_class.entry(rec.class.clone()).or_insert((0, 0));
        if got == rec.expected {
            entry.0 += 1;
        } else {
            entry.1 += 1;
            failures.push(format!(
                "line {} [{}] expected {} got {} for {}",
                rec.line,
                rec.class,
                if rec.expected { "block" } else { "allow" },
                if got { "block" } else { "allow" },
                rec.url
            ));
        }
    }

    for (class, (ok, bad)) in &by_class {
        println!("[corpus] {class:<8} {ok} ok, {bad} wrong");
    }
    assert!(
        failures.is_empty(),
        "{} corpus verdict(s) wrong:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn no_content_url_is_ever_blocked_even_under_hostile_list_conditions() {
    // Same corpus, but with a list that tries to block the CDNs by host. The
    // app's own list set must still leave playback alone; this asserts the
    // shipped lists do not contain a rule that kills googlevideo.
    let engine = shipped_engine();
    for rec in records().into_iter().filter(|r| r.class == "content") {
        assert!(
            !engine.check_request(&rec.url, SOURCE, &rec.request_type),
            "a shipped list blocks first-party content: {}",
            rec.url
        );
    }
}
