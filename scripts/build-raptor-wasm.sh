#!/usr/bin/env bash
set -euo pipefail

WASM_PREFIX="/src/wasm-libs"
BUILD_DIR="/src/wasm-build"
mkdir -p "$WASM_PREFIX" "$BUILD_DIR"

build_raptor2() {
  local VERSION="2.0.16"
  local TARBALL="raptor2-${VERSION}.tar.gz"
  local URL="https://download.librdf.org/source/${TARBALL}"
  local SRC_DIR="${BUILD_DIR}/raptor2-${VERSION}"

  if [ -f "$WASM_PREFIX/lib/libraptor2.a" ]; then
    echo "raptor2 already built, skipping."
    return 0
  fi

  echo "Downloading raptor2 ${VERSION}..."
  curl -L -o "${BUILD_DIR}/${TARBALL}" "${URL}"

  echo "Extracting raptor2..."
  tar -xzf "${BUILD_DIR}/${TARBALL}" -C "${BUILD_DIR}"

  echo "Configuring raptor2 for WASM..."
  cd "${SRC_DIR}"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix="$WASM_PREFIX" \
    --enable-static \
    --disable-shared \
    --without-www \
    --without-curl \
    --without-libfetch \
    --without-xml \
    --with-expat \
    --without-libxml2 \
    --disable-gtk-doc \
    --disable-doxygen-docs \
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib

  echo "Building raptor2..."
  emmake make -j$(nproc)
  emmake make install

  echo "raptor2 built and installed to $WASM_PREFIX"
}

build_librdf() {
  local VERSION="1.0.17"
  local TARBALL="redland-${VERSION}.tar.gz"
  local URL="https://download.librdf.org/source/${TARBALL}"
  local SRC_DIR="${BUILD_DIR}/redland-${VERSION}"

  if [ -f "$WASM_PREFIX/lib/librdf.a" ]; then
    echo "librdf already built, skipping."
    return 0
  fi

  echo "Downloading librdf (redland) ${VERSION}..."
  curl -L -o "${BUILD_DIR}/${TARBALL}" "${URL}"

  echo "Extracting librdf..."
  tar -xzf "${BUILD_DIR}/${TARBALL}" -C "${BUILD_DIR}"

  echo "Configuring librdf for WASM..."
  cd "${SRC_DIR}"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix="$WASM_PREFIX" \
    --enable-static \
    --disable-shared \
    --with-raptor2 \
    --without-rasqal \
    --without-sqlite \
    --without-mysql \
    --without-postgresql \
    --without-thrift \
    --without-virtuoso \
    --without-bdb \
    --disable-gtk-doc \
    PKG_CONFIG_PATH="$WASM_PREFIX/lib/pkgconfig" \
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib

  echo "Building librdf..."
  emmake make -j$(nproc)
  emmake make install

  echo "librdf built and installed to $WASM_PREFIX"
}

build_raptor2
build_librdf
echo "WASM libraries built successfully in $WASM_PREFIX"
