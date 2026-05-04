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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
