// SPDX-License-Identifier: GPL-3.0-or-later
//! Adversarial suite: hostile input must never panic, never block the player
//! endpoint, never block first-party YouTube assets, and must fail OPEN.
//!
//! Every test here encodes an invariant rather than a snapshot, so a change in
//! the pinned adblock version that breaks an invariant fails the suite.

use shieldtube::engine::ShieldEngine;
use std::sync::Arc;
use std::thread;
use std::time::Instant;

const YT: &str = "https://www.youtube.com/tv";

fn engine_with(rules: &str) -> ShieldEngine {
    let payload = serde_json::json!({
        "lists": [{
            "name": "adv.txt",
            "text": rules,
            "format": "standard",
            "trusted": true
        }],
        "resources": []
    })
    .to_string();
    ShieldEngine::create(&payload).expect("engine must build")
}

/// A list that would break playback if any of these rules ever matched.
const PLAYER_KILLERS: &str = "||youtube.com^\n\
||googlevideo.com^\n\
||ytimg.com^\n\
*$script\n\
*$xhr\n\
/youtubei/v1/*\n";

// ---------------------------------------------------------------------------
// Hostile filter-list content
// ---------------------------------------------------------------------------

#[test]
fn hostile_list_content_never_panics_and_keeps_invariants() {
    // Each entry is fed through the real create() path. None may panic; the
    // engine either builds or returns Err.
    let cases: Vec<(&str, String)> = vec![
        ("empty list", String::new()),
        ("only newlines", "\n\n\n\n".to_string()),
        ("garbage", "!!!@@@ ### $$$ %%% ^^^ &&& *** ((()))".to_string()),
        (
            "binary-ish",
            "\u{1}\u{2}\u{3}\u{7}\u{8}\u{b}\u{c}\u{1b}\u{7f}".to_string(),
        ),
        ("BOM + CRLF", "\u{feff}||doubleclick.net^\r\n||ads.y^\r\n".to_string()),
        ("CR only", "||doubleclick.net^\r||ads.z^\r".to_string()),
        ("lone surrogate-ish escape", "||a^\\ud800".to_string()),
        (
            "absurd single rule 200k",
            format!("||{}^\n", "a".repeat(200_000)),
        ),
        (
            "absurd single rule 1M",
            format!("||{}^\n", "a".repeat(1_000_000)),
        ),
        ("10k blank lines", "\n".repeat(10_000)),
        ("regex bomb", "/^(a+)+$/$script\n".to_string()),
        ("deeply nested cosmetic", format!("##{}", ":not(".repeat(200))),
        ("unterminated regex", "/(abc/$script\n".to_string()),
        ("hosts format junk", "0.0.0.0\n0.0.0.0 #comment\n::1\n".to_string()),
        (
            "scriptlet with no resource",
            "youtube.com##+js(does-not-exist.js, arg)\n".to_string(),
        ),
    ];

    for (label, text) in cases {
        let payload = serde_json::json!({
            "lists": [{"name": "h.txt", "text": text, "format": "standard", "trusted": true}],
            "resources": []
        })
        .to_string();
        // Must not panic. Err is acceptable; a panic is not.
        let outcome = std::panic::catch_unwind(|| ShieldEngine::create(&payload));
        assert!(outcome.is_ok(), "create() panicked on: {label}");

        if let Ok(engine) = outcome.unwrap() {
            // Invariants that must hold whatever the list contained.
            assert!(
                !engine.check_request("https://www.youtube.com/youtubei/v1/player?key=x", YT, "xhr"),
                "player endpoint blocked after loading hostile list: {label}"
            );
            let cosmetic = engine.cosmetic_for("https://www.youtube.com/watch?v=x");
            assert!(
                serde_json::from_str::<serde_json::Value>(&cosmetic).is_ok(),
                "cosmetic JSON became invalid after hostile list: {label}"
            );
        }
    }
}

#[test]
fn hostile_list_cannot_kill_the_player_even_when_it_applies() {
    // PLAYER_KILLERS matches youtube.com and everything of type script/xhr.
    // The allow-list must still win for the two player endpoints.
    let engine = engine_with(PLAYER_KILLERS);
    for url in [
        "https://www.youtube.com/youtubei/v1/player?key=a",
        "https://www.youtube.com/youtubei/v1/next?key=a",
        "https://www.youtube.com/youtubei/v1/player",
    ] {
        assert!(
            !engine.check_request(url, YT, "xhr"),
            "player endpoint blocked by aggressive list: {url}"
        );
    }
}

#[test]
fn hostile_list_does_not_block_first_party_assets_when_rules_are_traffic_shaped() {
    // Realistic list content (not the *$script bomb, which legitimately would).
    let engine = engine_with("||doubleclick.net^\n||googlesyndication.com^\n||ads.example.org^$script\n");
    for url in [
        "https://www.youtube.com/s/desktop/abc/js/base.js",
        "https://www.youtube.com/s/player/abc/player_ias.vflset/en_US/base.js",
        "https://i.ytimg.com/vi/abc/hqdefault.jpg",
        "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1",
        "https://www.youtube.com/youtubei/v1/next?key=a",
    ] {
        assert!(
            !engine.check_request(url, YT, "script"),
            "first-party asset blocked: {url}"
        );
    }
}

#[test]
fn truncated_and_invalid_payloads_are_rejected_not_fatal() {
    let payloads = [
        "",
        "{",
        "}",
        "[]",
        "null",
        r#"{"lists":"not-an-array"}"#,
        r#"{"lists":[{"name":123}]}"#,
        r#"{"lists":[{"text":"||a^"}],"resources":"nope"}"#,
        r#"{"lists":[{"text":"||a^"}],"resources":[{"name":"x"}]}"#,
        r#"{"lists":[{"name":"a","text":"||a^","format":"weird","trusted":true}],"resources":[]}"#,
    ];
    for p in payloads {
        let outcome = std::panic::catch_unwind(|| ShieldEngine::create(p));
        assert!(outcome.is_ok(), "create() panicked on payload: {p:?}");
        // Whatever happens, a rejected payload must not produce a working
        // engine from garbage; Ok is fine for permissive shapes.
        if let Ok(engine) = outcome.unwrap() {
            assert!(!engine.check_request("https://www.youtube.com/youtubei/v1/player", YT, "xhr"));
        }
    }
}

#[test]
fn add_lists_with_hostile_payload_fails_cleanly_and_keeps_working_engine() {
    let engine = engine_with("||doubleclick.net^\n");
    assert!(engine.check_request("https://doubleclick.net/a.js", YT, "script"));

    for bad in ["", "{", "not json", r#"{"lists":"x"}"#] {
        let outcome = std::panic::catch_unwind(|| engine.add_lists(bad));
        assert!(outcome.is_ok(), "add_lists panicked on {bad:?}");
        // A failed update must leave the previous engine usable.
        assert!(
            engine.check_request("https://doubleclick.net/a.js", YT, "script"),
            "a failed add_lists() destroyed the working engine (input: {bad:?})"
        );
    }
}

// ---------------------------------------------------------------------------
// Hostile URLs
// ---------------------------------------------------------------------------

#[test]
fn hostile_urls_never_panic_and_never_block_the_player() {
    let engine = engine_with("||doubleclick.net^\n");
    let urls: Vec<String> = vec![
        String::new(),
        " ".to_string(),
        "\u{0}".to_string(),
        "not a url".to_string(),
        "https://".to_string(),
        "https:///path".to_string(),
        // IDN / punycode, in both forms
        "https://xn--bcher-kva.example/x".to_string(),
        "https://bücher.example/x".to_string(),
        // confusables: Cyrillic 'а' (U+0430) instead of Latin 'a'
        "https://doublеclick.net/x".to_string(),
        // percent-encoding of the host and of the path
        "https://doubleclick%2enet/x".to_string(),
        "https://doubleclick.net/%2e%2e%2fadmin".to_string(),
        // trailing dot, port, userinfo
        "https://doubleclick.net./x".to_string(),
        "https://doubleclick.net:8443/x".to_string(),
        "https://user:pass@doubleclick.net/x".to_string(),
        "https://doubleclick.net@evil.example/x".to_string(),
        // IPv6 literal and IPv4 forms
        "http://[::1]:8080/x".to_string(),
        "http://127.0.0.1/x".to_string(),
        "http://0x7f.1/x".to_string(),
        // whitespace and control characters inside
        "https://double click.net/x".to_string(),
        "https://doubleclick.net/\nx".to_string(),
        " https://doubleclick.net/x ".to_string(),
        // scheme-relative and opaque
        "//doubleclick.net/x".to_string(),
        "javascript:alert(1)".to_string(),
        "data:text/html,<script>x</script>".to_string(),
        "about:blank".to_string(),
        "chrome://settings".to_string(),
        // absurd length
        format!("https://doubleclick.net/{}", "a".repeat(8 * 1024)),
        format!("https://{}", "a".repeat(8 * 1024)),
    ];

    for url in urls {
        for kind in ["script", "image", "xhr", "document", "", "UNKNOWN_TYPE"] {
            let outcome = std::panic::catch_unwind(|| engine.check_request(&url, YT, kind));
            assert!(
                outcome.is_ok(),
                "check_request panicked on url={url:?} type={kind:?}"
            );
        }
        // The player allow-list must hold for the hostile-URL corpus too.
        let hostiles = [
            format!("https://www.youtube.com/youtubei/v1/player?u={url}"),
            format!("HTTPS://WWW.YOUTUBE.COM/YOUTUBEI/V1/PLAYER?u={url}"),
        ];
        for h in hostiles {
            assert!(
                !engine.check_request(&h, YT, "xhr"),
                "player endpoint blocked with hostile query: {h:?}"
            );
        }
    }
}

#[test]
fn cosmetic_for_never_panics_on_hostile_urls() {
    let engine = engine_with("youtube.com##.video-ads\n");
    for url in [
        "",
        "\u{0}",
        "not a url",
        "https://",
        "https://[::1",
        &format!("https://www.youtube.com/{}", "a".repeat(8 * 1024)),
        "javascript:void(0)",
    ] {
        let outcome = std::panic::catch_unwind(|| engine.cosmetic_for(url));
        assert!(outcome.is_ok(), "cosmetic_for panicked on {url:?}");
        let json = outcome.unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("cosmetic_for must always return valid JSON");
        assert!(parsed.get("hide_selectors").is_some());
    }
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

#[test]
fn concurrent_check_request_is_deterministic_and_does_not_deadlock() {
    let engine = Arc::new(engine_with(
        "||doubleclick.net^\n||ads.example.org^$script\nyoutube.com##.video-ads\n",
    ));

    // Reference answers computed single-threaded.
    let cases: Vec<(String, &str)> = vec![
        ("https://doubleclick.net/a.js".into(), "script"),
        ("https://ads.example.org/a.js".into(), "script"),
        ("https://ads.example.org/a.png".into(), "image"),
        ("https://www.youtube.com/s/desktop/base.js".into(), "script"),
        ("https://www.youtube.com/youtubei/v1/player?key=x".into(), "xhr"),
    ];
    let expected: Vec<bool> = cases
        .iter()
        .map(|(u, t)| engine.check_request(u, YT, t))
        .collect();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let engine = Arc::clone(&engine);
        let cases = cases.clone();
        let expected = expected.clone();
        handles.push(thread::spawn(move || {
            for _ in 0..500 {
                for (i, (url, kind)) in cases.iter().enumerate() {
                    let got = engine.check_request(url, YT, kind);
                    assert_eq!(got, expected[i], "non-deterministic verdict for {url}");
                }
            }
        }));
    }
    for h in handles {
        h.join().expect("worker thread panicked or deadlocked");
    }
    assert_eq!(expected, vec![true, true, false, false, false]);
}

#[test]
fn concurrent_readers_survive_a_concurrent_rebuild() {
    let engine = Arc::new(engine_with("||doubleclick.net^\n"));
    let writers_engine = Arc::clone(&engine);

    let writer = thread::spawn(move || {
        for i in 0..25 {
            let payload = serde_json::json!({
                "replace": true,
                "lists": [{
                    "name": "w.txt",
                    "text": format!("||doubleclick.net^\n||ads{}.example^\n", i % 3),
                    "format": "standard",
                    "trusted": true
                }]
            })
            .to_string();
            writers_engine.add_lists(&payload).expect("rebuild must succeed");
        }
    });

    let mut readers = Vec::new();
    for _ in 0..4 {
        let engine = Arc::clone(&engine);
        readers.push(thread::spawn(move || {
            for _ in 0..500 {
                // Must never panic, block forever, or see a torn engine.
                let _ = engine.check_request("https://doubleclick.net/a.js", YT, "script");
                let _ = engine.check_request("https://www.youtube.com/youtubei/v1/player", YT, "xhr");
                let json = engine.cosmetic_for("https://www.youtube.com/watch?v=x");
                assert!(serde_json::from_str::<serde_json::Value>(&json).is_ok());
            }
        }));
    }
    writer.join().expect("writer panicked");
    for r in readers {
        r.join().expect("reader panicked");
    }

    // After the rebuild storm the engine must still enforce the invariant.
    assert!(engine.check_request("https://doubleclick.net/a.js", YT, "script"));
    assert!(!engine.check_request("https://www.youtube.com/youtubei/v1/player", YT, "xhr"));
}

// ---------------------------------------------------------------------------
// Perf envelope (guardrails, not benchmarks)
// ---------------------------------------------------------------------------

/// Median / p95 / max latency over a mixed corpus. Printed with --nocapture.
#[test]
fn block_decision_latency_envelope() {
    const BUNDLED: &str = include_str!("../../app/src/main/assets/lists/ubo-filters.txt");
    let engine = engine_with(BUNDLED);

    let corpus: Vec<(&str, &str)> = vec![
        ("https://doubleclick.net/ads/banner.js", "script"),
        ("https://www.googlesyndication.com/pagead/js/adsbygoogle.js", "script"),
        ("https://www.youtube.com/s/desktop/abc/js/base.js", "script"),
        ("https://i.ytimg.com/vi/abc/hqdefault.jpg", "image"),
        ("https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1", "media"),
        ("https://www.youtube.com/youtubei/v1/next?key=a", "xhr"),
        ("https://cdn.example.com/style.css", "stylesheet"),
        ("https://analytics.example.com/collect?v=1", "xhr"),
        ("https://fonts.example.com/f.woff2", "font"),
        ("https://www.youtube.com/watch?v=abc", "document"),
    ];

    // Warm up (first call includes lazy filter-index construction).
    for _ in 0..100 {
        for (u, t) in &corpus {
            std::hint::black_box(engine.check_request(u, YT, t));
        }
    }

    let iterations = 10_000;
    let mut samples = Vec::with_capacity(iterations);
    for i in 0..iterations {
        let (u, t) = corpus[i % corpus.len()];
        let start = Instant::now();
        std::hint::black_box(engine.check_request(u, YT, t));
        samples.push(start.elapsed().as_nanos() as u64);
    }
    samples.sort_unstable();
    let pct = |p: f64| samples[((samples.len() - 1) as f64 * p) as usize];
    let (p50, p95, max) = (pct(0.50), pct(0.95), samples[samples.len() - 1]);
    println!(
        "[perf] check_request over {iterations} mixed URLs: p50={p50}ns p95={p95}ns max={max}ns ({} filters)",
        BUNDLED.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('!')).count()
    );

    // `cargo test` builds this profile with opt-level 0, so the numbers here
    // are roughly 25-40x the release numbers (measured: debug p50 ~46us vs
    // release p50 ~1.7us on the same 3,663-filter list). Guardrails are set for
    // the DEBUG profile because that is what CI runs: generous enough not to
    // flake on a shared runner, tight enough to catch an accidental O(n) scan
    // of the filter table or a re-parse per call.
    //
    // `max` is deliberately NOT gated. Measured: a single call can hit 15.6 ms
    // in a debug build from OS scheduling alone, and the same corpus in release
    // never exceeds 49 us over 10k calls. Gating on max would be gating on the
    // CI runner's other tenants, not on the engine.
    assert!(p50 < 200_000, "p50 {p50}ns exceeds 200us guardrail");
    assert!(p95 < 1_000_000, "p95 {p95}ns exceeds 1ms guardrail");
    assert!(
        max < 100_000_000,
        "max {max}ns exceeds 100ms: something pathological happened"
    );
    println!("[perf] max={max}ns is reported, not gated (see comment in test)");
}

#[test]
fn full_list_rebuild_time_envelope() {
    // Every shipped list, exactly as the app loads them.
    let assets = [
        include_str!("../../app/src/main/assets/lists/brave-specific.txt"),
        include_str!("../../app/src/main/assets/lists/ubo-filters.txt"),
        include_str!("../../app/src/main/assets/lists/ubo-unbreak.txt"),
        include_str!("../../app/src/main/assets/lists/easylist-core.txt"),
        include_str!("../../app/src/main/assets/lists/easyprivacy-core.txt"),
        include_str!("../../app/src/main/assets/lists/brave-unbreak.txt"),
    ];
    let payload = serde_json::json!({
        "lists": assets.iter().enumerate().map(|(i, text)| serde_json::json!({
            "name": format!("l{i}.txt"),
            "text": text,
            "format": "standard",
            "trusted": true
        })).collect::<Vec<_>>(),
        "resources": []
    })
    .to_string();

    let start = Instant::now();
    let engine = ShieldEngine::create(&payload).expect("full list set must build");
    let first = start.elapsed();
    println!("[perf] cold build of all 6 shipped lists: {first:?} ({} bytes of JSON)", payload.len());
    assert!(engine.check_request("https://doubleclick.net/a.js", YT, "script"));

    // A rebuild is what ListUpdater triggers; time it as the user experiences it.
    let replace = serde_json::json!({
        "replace": true,
        "lists": assets.iter().enumerate().map(|(i, text)| serde_json::json!({
            "name": format!("l{i}.txt"), "text": text, "format": "standard", "trusted": true
        })).collect::<Vec<_>>()
    })
    .to_string();
    let start = Instant::now();
    engine.add_lists(&replace).expect("rebuild must succeed");
    let rebuild = start.elapsed();
    println!("[perf] rebuild of all 6 shipped lists: {rebuild:?}");

    // The updater runs this on a background thread; 30 s would still be a
    // usability bug on a TV box, so flag anything beyond it.
    assert!(first.as_secs() < 30, "cold build took {first:?}");
    assert!(rebuild.as_secs() < 30, "rebuild took {rebuild:?}");
}
