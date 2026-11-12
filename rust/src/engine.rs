// SPDX-License-Identifier: GPL-3.0-or-later
//! Engine state. One instance per process, shared across WebView's network
//! thread and the UI thread; `Engine` is Send + Sync because the crate's
//! `single-thread` feature is disabled.

use adblock::{
    lists::{FilterFormat, FilterSet, ParseOptions},
    request::Request,
    resources::{PermissionMask, Resource},
    Engine,
};
use std::borrow::Cow;
use std::sync::RwLock;

/// Safe fallback returned when a cosmetic query cannot be serialised.
pub const EMPTY_COSMETIC_JSON: &str = r#"{"hide_selectors":[],"procedural_actions":[],"exceptions":[],"injected_script":"","generichide":false}"#;

/// All eight permission bits granted to *bundled, checksummed* lists only.
/// See docs/SPEC-DEVIATIONS.md, "Trust decision: PermissionMask::from_bits(0xff)".
/// `PermissionMask::from_bits` is a const fn in adblock 0.13.5.
pub const FULL_TRUST: PermissionMask = PermissionMask::from_bits(0xff);

/// Never block these; killing the player endpoint kills playback (preamble §8).
/// Compared case-insensitively: an upper-cased request (HTTPS://WWW.YOUTUBE.COM/
/// YOUTUBEI/V1/PLAYER) must be caught by this allow-list too, or a list rule
/// could kill playback through a case variant.
const PLAYER_ENDPOINT_FRAGMENTS: [&str; 2] = ["youtubei/v1/player", "youtubei/v1/next"];

/// Lowercase the ASCII scheme and authority, leave everything else untouched.
///
/// Why this is necessary rather than defensive: `url::Url` and browsers
/// lower-case the scheme and host, but only the *first*. A request can arrive
/// as `HTTPS://GoogleTagServices.COM/x` and mean exactly the same thing.
///
/// adblock 0.13.5 normalises the scheme (`parser.rs:332`,
/// `'A'..='Z' => push(c.to_ascii_lowercase())`) but NOT an all-ASCII host:
/// `parse_host` does `write!(&mut self.serialization, "{host_str}")` verbatim
/// and only calls `idna::domain_to_ascii` for non-ASCII hosts. Its filter
/// matching is therefore case-sensitive on the host, and
/// `RequestType` mapping (`cpt_match_type`) is case-sensitive on the type
/// string. Measured before this fix: `https://DOUBLECLICK.NET/a.js` was NOT
/// blocked while `https://doubleclick.net/a.js` was.
///
/// Only the scheme and authority are rewritten, and only if they contain an
/// ASCII upper-case byte, so the common all-lowercase path does not allocate
/// and the path/query/fragment are passed through byte for byte (a filter like
/// `/Ad_300x250/` may be case-sensitive on purpose).
pub fn normalise_scheme_and_host(url: &str) -> Cow<'_, str> {
    // scheme end
    let scheme_end = match url.find(':') {
        Some(i) => i,
        None => return Cow::Borrowed(url),
    };
    if !url[..scheme_end]
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
    {
        return Cow::Borrowed(url); // not a scheme; leave it alone
    }
    // Authority starts after "://" or, for scheme-relative forms, "//".
    // Anything else (mailto:, data:, javascript:, "http:foo") has no authority.
    let rest = &url[scheme_end..];
    let auth_start = if rest.starts_with("://") {
        scheme_end + 3
    } else if rest.starts_with("//") {
        scheme_end + 2
    } else {
        return lowercase_prefix(url, scheme_end);
    };
    let auth = &url[auth_start..];
    let auth_end = auth
        .find(['/', '?', '#'])
        .map(|i| auth_start + i)
        .unwrap_or(url.len());
    let candidate = &url[..auth_end];
    let needs_lower = candidate.bytes().any(|b| b.is_ascii_uppercase());
    if !needs_lower {
        return Cow::Borrowed(url);
    }
    let mut out = String::with_capacity(url.len());
    out.push_str(&candidate.to_ascii_lowercase());
    out.push_str(&url[auth_end..]);
    Cow::Owned(out)
}

/// Lowercase just the scheme part of an opaque URL (no authority).
fn lowercase_prefix(url: &str, scheme_end: usize) -> Cow<'_, str> {
    if url[..scheme_end].bytes().any(|b| b.is_ascii_uppercase()) {
        let mut out = String::with_capacity(url.len());
        out.push_str(&url[..scheme_end].to_ascii_lowercase());
        out.push_str(&url[scheme_end..]);
        Cow::Owned(out)
    } else {
        Cow::Borrowed(url)
    }
}

/// Canonical request type. `cpt_match_type` in adblock 0.13.5 is an exact-match
/// `match`, so "SCRIPT" would silently become `RequestType::Other` and a
/// `$script` rule would stop matching. Kotlin already sends lower case; this
/// makes the Rust entry points safe for every caller (including the C ABI).
fn canonical_request_type(request_type: &str) -> Cow<'_, str> {
    if request_type.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Owned(request_type.to_ascii_lowercase())
    } else {
        Cow::Borrowed(request_type)
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct ListEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub text: String,
    /// "standard" (default) or "hosts".
    #[serde(default)]
    pub format: String,
    /// true only for lists vendored into the APK and covered by CHECKSUMS.json.
    #[serde(default)]
    pub trusted: bool,
}

#[derive(serde::Deserialize)]
pub struct CreatePayload {
    #[serde(default)]
    pub lists: Vec<ListEntry>,
    #[serde(default)]
    pub resources: Vec<Resource>,
}

#[derive(serde::Deserialize)]
pub struct AddListsPayload {
    #[serde(default)]
    pub lists: Vec<ListEntry>,
    /// Replace the whole list set (used by the 24 h updater).
    #[serde(default)]
    pub replace: bool,
}

struct State {
    lists: Vec<ListEntry>,
    resources: Vec<Resource>,
    engine: Engine,
}

fn build_engine(lists: &[ListEntry], resources: &[Resource]) -> Result<Engine, String> {
    let mut set = FilterSet::new(false);
    for list in lists {
        let mut opts = ParseOptions {
            format: if list.format.eq_ignore_ascii_case("hosts") {
                FilterFormat::Hosts
            } else {
                FilterFormat::Standard
            },
            ..ParseOptions::default()
        };
        // Trust is a property of the *list*, applied at parse time. The engine
        // checks `!filter_mask & resource.permission == 0` at injection time.
        opts.permissions = if list.trusted {
            FULL_TRUST
        } else {
            PermissionMask::default()
        };
        let _record = set.add_filter_list(list.text.clone(), opts);
    }
    let mut engine = Engine::new_with_filter_set(set);
    // `use_resources` (not `set_resources`) is the real 0.13.5 API.
    engine.use_resources(resources.iter().cloned());
    Ok(engine)
}

impl State {
    fn new(lists: Vec<ListEntry>, resources: Vec<Resource>) -> Result<Self, String> {
        let engine = build_engine(&lists, &resources)?;
        Ok(Self {
            lists,
            resources,
            engine,
        })
    }

    /// Rules cannot be added to an existing Engine, so a list update rebuilds.
    fn rebuild(&mut self) -> Result<(), String> {
        self.engine = build_engine(&self.lists, &self.resources)?;
        Ok(())
    }
}

pub struct ShieldEngine {
    state: RwLock<State>,
}

impl ShieldEngine {
    pub fn create(json: &str) -> Result<Self, String> {
        let payload: CreatePayload = serde_json::from_str(json).map_err(|e| e.to_string())?;
        Ok(Self {
            state: RwLock::new(State::new(payload.lists, payload.resources)?),
        })
    }

    pub fn add_lists(&self, json: &str) -> Result<usize, String> {
        let payload: AddListsPayload = serde_json::from_str(json).map_err(|e| e.to_string())?;
        // Poisoned locks are recovered: a panic during a rebuild must not wedge
        // the WebView permanently.
        let mut guard = self.state.write().unwrap_or_else(|p| p.into_inner());
        if payload.replace {
            guard.lists.clear();
        }
        for incoming in payload.lists {
            if let Some(pos) = guard.lists.iter().position(|l| l.name == incoming.name) {
                guard.lists[pos] = incoming;
            } else {
                guard.lists.push(incoming);
            }
        }
        guard.rebuild()?;
        Ok(guard.lists.len())
    }

    /// Scalar boolean. `Request::new` in 0.13.5 takes (url, source_url,
    /// request_type, method); a wrong request_type produces false positives,
    /// so Kotlin maps WebView resource types explicitly (RequestTypeMapper.kt).
    pub fn check_request(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        let url = normalise_scheme_and_host(url);
        let source_url = normalise_scheme_and_host(source_url);
        let request_type = canonical_request_type(request_type);
        // Case-insensitive on purpose: see PLAYER_ENDPOINT_FRAGMENTS.
        let lowered_url = url.to_ascii_lowercase();
        if PLAYER_ENDPOINT_FRAGMENTS
            .iter()
            .any(|p| lowered_url.contains(p))
        {
            return false;
        }
        let guard = self.state.read().unwrap_or_else(|p| p.into_inner());
        match Request::new(&url, &source_url, &request_type, "get") {
            Ok(request) => guard.engine.check_network_request(&request).should_block(),
            Err(_) => false, // unparseable URL: fail open, never break playback
        }
    }

    /// JSON-out. Constructed field-by-field on purpose: if the pinned crate
    /// renames a UrlSpecificResources field, this stops compiling instead of
    /// silently emitting a different schema to Kotlin (lead condition 5).
    /// Verified against adblock 0.13.5: hide_selectors, procedural_actions,
    /// exceptions, injected_script, generichide. There is NO `style_selectors`.
    pub fn cosmetic_for(&self, url: &str) -> String {
        let guard = self.state.read().unwrap_or_else(|p| p.into_inner());
        let r = guard.engine.url_cosmetic_resources(url);
        serde_json::json!({
            "hide_selectors": r.hide_selectors,
            "procedural_actions": r.procedural_actions,
            "exceptions": r.exceptions,
            // Already fully templated by adblock-rust's patch_template_scriptlet;
            // DO NOT substitute {{1}}..{{9}} again.
            "injected_script": r.injected_script,
            "generichide": r.generichide,
        })
        .to_string()
    }
}
