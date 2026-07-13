# Security policy

## Superficie locale

DSBox è progettato per un solo utente sullo stesso Mac:

- control plane: `127.0.0.1:4242`;
- ds4 interno: `127.0.0.1:8000` per default;
- nessun bind `0.0.0.0` supportato dal control plane;
- nessun CORS abilitato sul runtime;
- header anti-CSRF obbligatorio per le mutazioni `/api/*`;
- API key opzionale sul gateway `/v1/*`.

Non pubblicare queste porte su Internet. Per accesso remoto usa un tunnel autenticato.

## Dati sensibili

La trace ds4 può contenere richieste, prompt renderizzati, output e tool call. I checkpoint KV possono contenere testo del prompt. Prima di condividere log o support bundle:

1. disabilita trace se non necessaria;
2. controlla manualmente i file;
3. rimuovi codice, segreti, path personali e conversazioni;
4. non pubblicare `~/.dsbox/config.json` se contiene un token gateway usato altrove.

## Segnalazioni

Non aprire issue pubbliche con exploit funzionanti, token o dati privati. Condividi inizialmente una descrizione minimale e riproducibile con il maintainer del repository che ospiterà DSBox.

