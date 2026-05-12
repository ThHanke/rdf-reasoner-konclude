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
  # --enable-parsers replaces the default list (which includes rdfxml requiring libxml2).
  # Space-separated values are the correct syntax for this flag.
  # CFLAGS=-D__GLIBC__ fixes sort_r.h OS detection for Emscripten.
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix="$WASM_PREFIX" \
    --enable-static \
    --disable-shared \
    --without-www \
    "--enable-parsers=ntriples turtle nquads" \
    "--enable-serializers=ntriples" \
    --disable-gtk-doc \
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib \
    CFLAGS="-D__GLIBC__ -matomics -mbulk-memory -pthread -O3 -DNDEBUG -flto"

  echo "Building raptor2..."
  emmake make -j$(nproc)
  emmake make install

  echo "raptor2 built and installed to $WASM_PREFIX"
}

build_rasqal() {
  local VERSION="0.9.33"
  local TARBALL="rasqal-${VERSION}.tar.gz"
  local URL="https://download.librdf.org/source/${TARBALL}"
  local SRC_DIR="${BUILD_DIR}/rasqal-${VERSION}"

  if [ -f "$WASM_PREFIX/lib/librasqal.a" ]; then
    echo "rasqal already built, skipping."
    return 0
  fi

  echo "Downloading rasqal ${VERSION}..."
  curl -L -o "${BUILD_DIR}/${TARBALL}" "${URL}"

  echo "Extracting rasqal..."
  tar -xzf "${BUILD_DIR}/${TARBALL}" -C "${BUILD_DIR}"

  # Use raptor2's config.sub — same issue as librdf.
  echo "Updating config.sub for Emscripten..."
  cp "${BUILD_DIR}/raptor2-2.0.16/build/config.sub" "${SRC_DIR}/build/config.sub"

  echo "Configuring rasqal for WASM..."
  cd "${SRC_DIR}"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix="$WASM_PREFIX" \
    --enable-static \
    --disable-shared \
    --without-pcre \
    --disable-gtk-doc \
    PKG_CONFIG_PATH="$WASM_PREFIX/lib/pkgconfig" \
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib \
    CFLAGS="-D__GLIBC__ -matomics -mbulk-memory -pthread -O3 -DNDEBUG -flto"

  echo "Building rasqal..."
  emmake make -j$(nproc)
  emmake make install

  echo "rasqal built and installed to $WASM_PREFIX"
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

  # librdf 1.0.17 ships old config.sub in both build/ and libltdl/config/.
  echo "Updating config.sub for Emscripten..."
  local RAPTOR_CONFIG_SUB="${BUILD_DIR}/raptor2-2.0.16/build/config.sub"
  cp "${RAPTOR_CONFIG_SUB}" "${SRC_DIR}/build/config.sub"
  cp "${RAPTOR_CONFIG_SUB}" "${SRC_DIR}/libltdl/config/config.sub"

  echo "Configuring librdf for WASM..."
  cd "${SRC_DIR}"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix="$WASM_PREFIX" \
    --enable-static \
    --disable-shared \
    --with-raptor2 \
    --without-sqlite \
    --without-mysql \
    --without-postgresql \
    --without-thrift \
    --without-virtuoso \
    --without-bdb \
    --disable-gtk-doc \
    PKG_CONFIG_PATH="$WASM_PREFIX/lib/pkgconfig" \
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib \
    CFLAGS="-matomics -mbulk-memory -pthread -O3 -DNDEBUG -flto"

  echo "Building librdf..."
  emmake make -j$(nproc)
  emmake make install

  echo "librdf built and installed to $WASM_PREFIX"
}

build_raptor2
build_rasqal
build_librdf
echo "WASM libraries built successfully in $WASM_PREFIX"
