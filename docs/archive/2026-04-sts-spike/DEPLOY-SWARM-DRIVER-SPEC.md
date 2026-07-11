# Archived swarm-driver deployment note

This historical document was scrubbed on 2026-07-11 because it contained live provider credentials.

Do not reconstruct deployment commands with inline keys. Runtime secrets belong in the deployment platform or the VPS secret store and must be loaded by name. The credentials formerly present here must be treated as compromised and rotated before STS is released.

For current setup requirements, use `.env.example` and the production-readiness documentation.
