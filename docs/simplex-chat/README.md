# SimpleX Chat

Reference overview of [simplex-chat/simplex-chat](https://github.com/simplex-chat/simplex-chat) — a privacy-first messaging platform with **no user identifiers**.

> **Website:** [simplex.chat](https://simplex.chat)  
> **License:** [AGPL-3.0](https://github.com/simplex-chat/simplex-chat/blob/stable/LICENSE)  
> **Default branch:** `stable`

---

## What It Is

SimpleX Chat is the reference client for the **SimpleX Network** — a messaging platform designed to be private by default. Unlike Signal, Matrix, or Session, it assigns **no persistent user IDs** (no phone numbers, usernames, or random account keys shared across conversations).

Connections are made via **one-time invitation links** or **QR codes**. Each conversation uses separate message queues, so there is no shared metadata linking your contacts to each other.

---

## Why It Matters

| Problem | SimpleX approach |
|---------|------------------|
| Phone/email as identity | No global identifiers — pairwise per-queue addresses only |
| Server knows who talks to whom | Relays store messages temporarily; no user graph on servers |
| Spam / unsolicited contact | Nobody can message you unless you share a link or address |
| Data on servers | All contacts, groups, and history live on client devices |

---

## Architecture

SimpleX is a **client–server** network (not P2P, not federated like Matrix):

```
User A ──E2EE──► Relay Server ──E2EE──► User B
         (separate queue)    (in-memory, no user records)
```

- Messages pass through **disposable relay nodes** via unidirectional (simplex) queues
- Servers **do not communicate** with each other and **do not persist** delivered messages
- Only client devices hold user data, contacts, and groups
- Protocol implementation: [simplexmq](https://github.com/simplex-chat/simplexmq) (SMP + XFTP for files)

**Security highlights:**

- Double ratchet E2EE (Signal-style) + extra NaCl encryption layer
- Post-quantum key exchange on every ratchet step (v5.6+)
- Private message routing by default (v6.0+) — hides sender IP from recipient servers
- Tor support, transport isolation, encrypted local database
- Audited by Trail of Bits (2022 implementation, 2024 protocol review)

---

## Repository Structure

| Path | Purpose |
|------|---------|
| `src/Simplex/` | Core Haskell library |
| `apps/simplex-chat/` | Terminal CLI |
| `apps/multiplatform/` | Android + desktop (Kotlin Compose) |
| `apps/ios/` | iOS app (Swift) |
| `apps/simplex-bot*` | Haskell chat bot examples |
| `packages/simplex-chat-client/` | TypeScript SDK (WebSocket to CLI) |
| `packages/simplex-chat-python/` | Python bindings |
| `packages/simplex-chat-nodejs/` | Node.js bindings |
| `bots/` | Bot API reference |
| `docs/` | Protocol specs, CLI guide, security docs |

**Primary languages:** Haskell, Kotlin, Swift, TypeScript

---

## Platforms

| Platform | Availability |
|----------|--------------|
| Android | [Google Play](https://play.google.com/store/apps/details?id=chat.simplex.app) / [APK](https://github.com/simplex-chat/simplex-chat/releases) |
| iOS | [App Store](https://apps.apple.com/us/app/simplex-chat/id1605771084) / [TestFlight](https://testflight.apple.com/join/DWuT2LQu) |
| Desktop | Multiplatform app |
| CLI | Linux, macOS, Windows |

### Quick CLI install

```sh
curl -o- https://raw.githubusercontent.com/simplex-chat/simplex-chat/stable/install.sh | bash
simplex-chat
```

See [CLI docs](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/CLI.md).

---

## Funding Model

SimpleX Chat Ltd is a **commercial company**, not a donation-only project.

| Source | Details |
|--------|---------|
| **VC / angels** | ~$370k pre-seed (Village Global, 2022); **$1.3M** pre-seed led by Jack Dorsey + Asymmetric Capital Partners (2024) |
| **Donations** | GitHub Sponsors, OpenCollective, crypto — covers infrastructure; helped enable investment |
| **Planned revenue** | Freemium perks (badges, icons, file limits); B2B / team adoption |

Basic usage stays **free and open source**. Protocols remain **open / public domain**, with work toward non-profit governance (similar to Matrix).

Donation channels: [GitHub Sponsors](https://github.com/sponsors/simplex-chat) · [OpenCollective](https://opencollective.com/simplex-chat)

---

## For Developers

- **Chat bots** — run the terminal CLI as a local WebSocket server; see [`bots/README.md`](https://github.com/simplex-chat/simplex-chat/blob/stable/bots/README.md)
- **TypeScript client** — `packages/simplex-chat-client/` ([squaring-bot example](https://github.com/simplex-chat/simplex-chat/blob/stable/packages/simplex-chat-client/typescript/examples/squaring-bot.js))
- **Haskell bots** — `apps/simplex-bot/` and `apps/simplex-bot-advanced/`
- **Dev community** — [#simplex-devs](https://simplex.chat) group on SimpleX

---

## Key Links

- [Official README](https://github.com/simplex-chat/simplex-chat/blob/stable/README.md)
- [User guide](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/guide/README.md)
- [Protocol overview](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/overview-tjr.md)
- [FAQ](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/FAQ.md)
- [Security policy](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/SECURITY.md)
- [Blog / releases](https://simplex.chat/blog/)

---

## Stats (Jun 2025)

| Metric | Value |
|--------|-------|
| Stars | ~12.6k |
| Forks | ~714 |
| Created | Dec 2019 |
| Latest release track | v6.4.x |

---

*This is a reference summary, not part of the official SimpleX Chat project.*
