# ── Build stage ──────────────────────────────────────────
FROM rust:1.82-slim-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src/ ./src/

RUN cargo build --release

# ── Runtime stage ────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /bin/false -M atm-relay

COPY --from=builder /build/target/release/atm-relay /usr/local/bin/atm-relay
COPY relay-config.toml /etc/atm-relay/relay-config.toml

USER atm-relay

ENV RUST_LOG=atm_relay=info
ENV RELAY_CONFIG=/etc/atm-relay/relay-config.toml

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["atm-relay"]
