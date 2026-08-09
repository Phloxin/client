{
  description = "Pylon desktop client — development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          # Matches devDependencies electron ^43.1.0. Keep the two in sync.
          #
          # Chromium dlopens libva.so.2 at runtime for VAAPI. Without it the GPU
          # process silently falls back to software WebRTC codecs, which drops
          # the hardware H.264 profiles (notably High, 64001f) from the
          # advertised RTP capabilities — mediasoup then fails to consume High-
          # profile H.264 producers with "No compatible media codecs".
          electron = pkgs.symlinkJoin {
            name = "electron-vaapi-${pkgs.electron_43.version}";
            paths = [ pkgs.electron_43 ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postBuild = ''
              wrapProgram "$out/bin/electron" \
                --prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath [ pkgs.libva ]}
            '';
            inherit (pkgs.electron_43) version;
          };

          # The binary npm downloads into node_modules/electron/dist is a
          # generic-glibc ELF that cannot run on NixOS. node_modules/electron
          # resolves ELECTRON_OVERRIDE_DIST_PATH + "/electron" instead, so hand it
          # a dist directory whose `electron` entry is the *wrapped* nixpkgs
          # binary — the wrapper exports the GTK/GIO gsettings-schema paths the
          # bare binary needs for native dialogs.
          electronDist = pkgs.runCommand "electron-${electron.version}-dist" { } ''
            mkdir -p "$out"
            ln -s ${electron}/libexec/electron/* "$out"/
            rm "$out/electron"
            ln -s ${electron}/bin/electron "$out/electron"
          '';
        in
        {
          default = pkgs.mkShell {
            nativeBuildInputs = with pkgs; [
              nodejs_22 # package.json engines: >=22.12 <25
              electron # dev/build tooling that shells out to `electron`
              pkg-config

              # native/audio-capture (Rust napi module, PipeWire capture)
              cargo
              rustc
              rustPlatform.bindgenHook # LIBCLANG_PATH for pipewire-sys / libspa-sys

              # node-gyp, for when uiohook-napi compiles instead of using a prebuild
              python3
              gnumake
            ];

            buildInputs = with pkgs; [
              pipewire # libpipewire-0.3 + libspa headers for native/audio-capture
              libx11 # uiohook-napi links -lX11 -lXtst -lXrandr -lXt
              libxtst
              libxrandr
              libxt
            ];

            # electron-vite (dev/preview) resolves the binary itself and only
            # honours ELECTRON_EXEC_PATH; the rest of the tooling (electron-builder,
            # electron-rebuild, anything doing require('electron')) goes through
            # node_modules/electron, which honours ELECTRON_OVERRIDE_DIST_PATH.
            ELECTRON_EXEC_PATH = "${electron}/bin/electron";
            ELECTRON_OVERRIDE_DIST_PATH = "${electronDist}";

            shellHook = ''
              echo "pylon dev shell — node $(node --version), electron ${electron.version}"
            '';
          };
        }
      );
    };
}
