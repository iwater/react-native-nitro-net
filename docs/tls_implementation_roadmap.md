# TLS 100% Compatibility Implementation Roadmap

This document outlines the detailed technical plan to achieve **100% API compatibility** with the Node.js `tls` module. It addresses every feature currently marked as **❌ Not Supported** in the compatibility audit.

## Phase 5: Client Verification & Authorization (P0) ✅

**Goal**: Support `authorized`, `authorizationError`, and `rejectUnauthorized`.

### Problem
Currently, `rustls` (used by `rust_c_net`) enforces strict verification. If a certificate is invalid (e.g., self-signed), the handshake fails immediately, and the connection closes. Node.js allows `rejectUnauthorized: false`, where the handshake succeeds but `socket.authorized` is set to `false` and `socket.authorizationError` contains the reason.

### Implementation Plan
1.  **Rust Layer (`rust_c_net`)**:
    *   Implement a custom `rustls::client::ServerCertVerifier`.
    *   This verifier will wrap the default verifier.
    *   If `reject_unauthorized` is `true`: Delegate to default behavior (fail handshake).
    *   If `reject_unauthorized` is `false`: Attempt verification. If verification fails, **record the error** in the connection context but **return success** to allow the handshake to finish.
    *   Expose this verification error via a new FFI function `net_get_authorization_error(id)`.

2.  **TypeScript Layer (`tls.ts`)**:
    *   In `connect`, pass `rejectUnauthorized` option to native.
    *   In `TLSSocket` property getters:
        *   `authorized`: Call generic verification FFI. If verified, return `true`; otherwise `false`.
        *   `authorizationError`: Call `net_get_authorization_error`.
    *   Implement `checkServerIdentity`: This is a pure JS utility in Node.js. We can copy the implementation (using `cert` subject alt names) or rely on the native verifier's result if it checks verifying hostnames (which `rustls` does).

## Phase 6: Deep Socket Inspection (P1) ✅

**Goal**: Support all property getters: `getProtocol`, `getCipher`, `getEphemeralKeyInfo`, `getSharedSigalgs`, etc.

### Implementation Plan
1.  **Rust Layer**:
    *   Use `rustls::Connection` methods to extract this data.
    *   Expose FFI functions:
        *   `net_get_protocol_version(id)` -> e.g., "TLSv1.3"
        *   `net_get_cipher_suite(id)` -> e.g., "TLS_AES_256_GCM_SHA384"
        *   `net_get_ephemeral_key_info(id)` -> Curve name / public key params.
        *   `net_get_alpn_protocol(id)` -> Negotiated protocol (e.g., "h2", "http/1.1").

2.  **TypeScript Layer**:
    *   Map these Native getters to the standard Node.js API methods.
    *   `socket.getProtocol()`
    *   `socket.getCipher()` (returns object `{ name, version }`)
    *   `socket.alpnProtocol`

## Phase 7: Certificate Parsing (Broad & Deep) (P1) ✅

**Goal**: Support `getPeerCertificate(detailed)`.

### Problem
Node.js returns a complex JSON object for the certificate (Subject, Issuer, valid_from, fingerprint, etc.). `rustls` only gives raw DER bytes.

### Implementation Plan (Option A: Rust-side Parsing - Recommended)
1.  **Rust Layer**:
    *   Add `x509-parser` crate dependency.
    *   Implement `net_get_peer_certificate_json(id)`.
    *   Parse the DER certificate into a JSON string matching Node.js structure.
    *   Return JSON string to JS.

2.  **TypeScript Layer**:
    *   `getPeerCertificate()` calls the native function and `JSON.parse` the result.

## Phase 8: Session Management & Resumption (P2) ✅

**Goal**: Support `newSession`, `resumeSession` events, and session caching.

### Implementation Plan
1.  **Rust Layer**:
    *   Implement `rustls::client::ClientSessionStore` and `rustls::server::ServerSessionStore`.
    *   **Session Storage**: Use an in-memory map or allow JS to control storage.
    *   **Events**: When `rustls` stores a new ticket, emit `EVENT_SESSION_NEW` (bridge to `newSession` event).
    *   **Resumption**: Allow passing a session blob (ticket) into `net_connect_tls`.

2.  **TypeScript Layer**:
    *   Listen for `newSession`.
    *   Allow passing `session` in `connect` options.

## Phase 9: Advanced Server Features (P3) ✅

**Goal**: Support SNI (`server.addContext`), `getTicketKeys`, `setTicketKeys`.

### Implementation Plan
1.  **Rust Layer (`ResolvesServerCert`)**:
    *   Implement a dynamic certificate resolver trait.
    *   Maintain a `DashMap<String, Arc<CertifiedKey>>` (Hostname -> Certificate).
    *   `net_server_add_context(server_id, hostname, cert, key)`: Updates this map.

2.  **TypeScript Layer**:
    *   Implement `server.addContext(hostname, context)`.

## Phase 10: Custom CAs & Secure Contexts ✅

**Goal**: Support custom root CAs, client certificates, and standalone `SecureContext`.

### Implementation Plan
1.  **Rust Layer**:
    *   Update `net_create_secure_context` to accept `ca` (Root CAs) in additions to `cert`/`key`.
    *   Use `rustls::RootCertStore` for custom CAs.
    *   Implement client-side authentication (sending cert/key during handshake).
2.  **TypeScript Layer**:
    *   Implement `tls.createSecureContext(options)`.
    *   Expose `SecureContext` as an object that can be passed to `connect` and `createServer`.
    *   Implement `server.setSecureContext(options)`.

## Phase 11: OCSP, Tickets & Keylogging (P2) ✅

**Goal**: Support OCSP stapling, manual ticket key management, and debug logs.

### Implementation Plan
1.  **Rust Layer**:
    *   **OCSP**: Implement `rustls::server::OcspResponder` or manual stapling via `CertifiedKey`.
    *   **Ticket Keys**: Implement `rustls::server::ProducesTickets` to allow JS to set/get persistent ticket encryption keys (`getTicketKeys`, `setTicketKeys`).
    *   **Keylogging**: Implement `rustls::KeyLog` to emit `keylog` events containing NSS keylog format.
2.  **TypeScript Layer**:
    *   Support `OCSPResponse` and `OCSPRequest` events.
    *   Expose ticket key methods on `tls.Server`.

## Phase 12: Global APIs & Final Polish (P3) ✅

**Goal**: Complete the global API surface and implement JS-side utilities.

### Implementation Plan
1.  **Utilities**:
    *   `tls.checkServerIdentity(hostname, cert)`: Pure TypeScript implementation using SANs/CN from the certificate.
    *   `tls.getCiphers()`: Hardcoded or native-queried list of supported `rustls` suites.
2.  **Globals**:
    *   `tls.rootCertificates`: Array of PEM strings of built-in root CAs.
    *   `tls.DEFAULT_..._VERSION`: Constants for TLS version control.
3.  **Renegotiation**:
    *   Implement `renegotiate` as a stub that throws "Not supported by rustls".

## Phase 13: Unix Sockets & Advanced Inspection (P3) ✅

**Goal**: TLS over Unix sockets and niche property getters.

### Implementation
1.  **Unix Sockets**:
    *   Supported `tls.connect({ path: ... })` using logic in `socket.rs`.
2.  **Niche Getters**:
    *   `socket.getEphemeralKeyInfo()`: Extracts Key Exchange parameters from handshake.
    *   `socket.getSharedSigalgs()`: Inspects negotiated signature algorithms.

## Phase 14: PFX & Encrypted Credentials (P3) ✅

**Goal**: Support `pfx` (PKCS#12) and encrypted private keys (`passphrase`).

### Implementation Plan
1. **Rust Layer**:
    * Add `p12` or `openssl` crate (if available/needed) to parse PKCS#12 archives.
    * Decrypt private keys using the provided `passphrase`.
    * Extract certificates and converted to `rustls` format.
2. **TypeScript Layer**:
    * Expose `pfx` and `passphrase` options in `createSecureContext` and `connect`.

## Compatibility Matrix Summary

| Phase | Feature Set | Complexity | Status |
| :--- | :--- | :--- | :--- |
| **Phase 5** | **Client Verification** | Moderate | ✅ Complete |
| **Phase 6** | **Socket Inspection** | Low | ✅ Complete |
| **Phase 7** | **Certificate Parsing** | Low | ✅ Complete |
| **Phase 8** | **Session Resumption** | Moderate | ✅ Complete |
| **Phase 9** | **Advanced Server** (SNI) | Moderate | ✅ Complete |
| **Phase 10** | **Custom CAs & Contexts** | High | ✅ Complete |
| **Phase 11** | **OCSP & Tickets** | High | ✅ Complete |
| **Phase 12** | **Global APIs & Utilities** | Low | ✅ Complete |
| **Phase 13** | **Unix Sockets & Inspection** | Moderate | ✅ Complete |
| **Phase 14** | **PFX & Encrypted Keys** | Moderate | ✅ Complete |

---
*Roadmap updated: Phase 14 Complete - 2025-12-28*
