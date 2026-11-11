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
use std::sync::RwLock;

/// Safe fallback returned when a cosmetic query cannot be serialised.
pub const EMPTY_COSMETIC_JSON: &str = r#"{"hide_selectors":[],"procedural_actions":[],"exceptions":[],"injected_script":"","generichide":false}"#;

/// All eight permission bits granted to *bundled, checksummed* lists only.
/// See docs/SPEC-DEVIATIONS.md, "Trust decision: PermissionMask::from_bits(0xff)".
/// `PermissionMask::from_bits` is a const fn in adblock 0.13.5.
pub const FULL_TRUST: PermissionMask = PermissionMask::from_bits(0xff);

/// Never block these; killing the player endpoint kills playback (preamble §8).
const PLAYER_ENDPOINT_FRAGMENTS: [&str; 2] = ["youtubei/v1/player", "youtubei/v1/next"];

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
        if PLAYER_ENDPOINT_FRAGMENTS.iter().any(|p| url.contains(p)) {
            return false;
        }
        let guard = self.state.read().unwrap_or_else(|p| p.into_inner());
        match Request::new(url, source_url, request_type, "get") {
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
