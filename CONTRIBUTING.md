# Contribuire a DSBox

## Setup

```sh
npm ci
npm run dev
```

Prima di aprire una modifica:

```sh
npm run typecheck
npm test
npm run build
```

## Regole del runtime

- Non costruire comandi shell interpolati: usa sempre executable + array `argv`.
- Mantieni `ds4-server` su `127.0.0.1`; l'esposizione LAN non è parte del profilo base.
- Non aggiungere fallback CPU automatici su macOS.
- Non inviare `SIGKILL` nello stop normale: SIGTERM deve lasciare a ds4 il tempo di drenare e salvare KV.
- Verifica i flag contro `ds4-server --help all`; `main` e il branch GLM non hanno capability identiche.
- Non mostrare metriche Metal o I/O che non possono essere misurate in modo attendibile.
- Trace e KV cache vanno trattate come dati potenzialmente sensibili.

## UI

- Usa solo asset locali e rispetta `prefers-reduced-motion`.
- Mantieni navigazione da tastiera, nomi accessibili e layout senza overflow a 430 px.
- Le animazioni devono chiarire cambi di stato, non mascherare attese o errori.

## Test

Per log, SSE e processo usa fixture o fake server. Non avviare download reali di modelli nei test. I test che richiedono un GGUF o il backend Metal reale devono essere separati e opt-in.

