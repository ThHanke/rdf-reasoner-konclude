FROM emscripten/emsdk:3.1.73

# Build dependencies for compiling raptor2/librdf from source under Emscripten
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    libtool \
    pkg-config \
    libxml2-dev \
    libexpat1-dev \
    curl \
    ccache \
    && rm -rf /var/lib/apt/lists/*

# ccache: use content-based compiler check (emcc path changes between runs)
ENV CCACHE_COMPILERCHECK=content
ENV CCACHE_DIR=/ccache

WORKDIR /src
