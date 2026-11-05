# Notices

## Code license

The code in this repository is MIT (see [LICENSE](LICENSE)).

Parts of the browser engine (`lib/client.js`) are adapted from
[dsh-blue-whale-maid](https://github.com/yuxino/dsh-blue-whale-maid), MIT,
Copyright (c) 2026 yuxino: frame scheduling, bubble controller, drag handling,
and the "only report what is certain" copy rules. Changes here: external atlas
URL, no billing panel, no Codex-directory scanning, v1/v2 atlas versions, and
pet cycling.

## Artwork is not covered

Pet packages (`pet.json` + `spritesheet`) are supplied by the user and keep
their own author's terms. In particular, the Blue Whale Maid artwork is
personal, non-commercial use only:

- character art and metadata: **simashui** / [codex-pets.net](https://codex-pets.net/#/pets/blue-whale-maid)
- upstream repository: [yuxino/dsh-blue-whale-maid](https://github.com/yuxino/dsh-blue-whale-maid)

No artwork ships in this repository; see [assets/README.md](assets/README.md).

## Format references

- [Codex Pet contract](https://github.com/nexu-io/open-design/blob/main/skills/hatch-pet/references/codex-pet-contract.md)
- [Codex Pet v2 animation rows](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/Codex/plugins/work-pets/skills/create-pet/references/animation-rows.md)
- [IchenDEV/petx](https://github.com/IchenDEV/petx) — dual-version atlas renderer
