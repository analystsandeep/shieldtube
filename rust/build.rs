// SPDX-License-Identifier: GPL-3.0-or-later
//! Regenerates include/shieldtube.h with cbindgen on every build.

use std::{env, path::PathBuf};

fn main() {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let config = cbindgen::Config::from_file(crate_dir.join("cbindgen.toml"))
        .expect("cbindgen.toml is readable");

    // Parse only the C ABI module: JNI signatures reference jni::* types that
    // are meaningless to a C consumer.
    let bindings = cbindgen::Builder::new()
        .with_src(crate_dir.join("src/ffi_c.rs"))
        .with_config(config)
        .generate()
        .expect("cbindgen could not generate the C header");

    bindings.write_to_file(out_dir.join("shieldtube.h"));
    let include_dir = crate_dir.join("include");
    std::fs::create_dir_all(&include_dir).expect("include/ is writable");
    bindings.write_to_file(include_dir.join("shieldtube.h"));

    println!("cargo:rerun-if-changed=cbindgen.toml");
    println!("cargo:rerun-if-changed=src/ffi_c.rs");
}
