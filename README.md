# dashboard

Ein Claude-Code-Mod: ein Panel neben dem Chat und eine Zeile unter dem Prompt.

- **Context:** Füllstand des Context-Windows in Prozent und absolut (`422k / 1M · 578k frei`).
- **5h-Limit und Weekly:** wie viel Prozent genutzt sind und wann sie zurückgesetzt werden (nur mit Abo, nach der ersten Antwort).
- **Workflows:** jeder laufende Workflow der Session mit Fortschrittsbalken (fertige Agenten über alle, eine noch nicht gestartete Phase zählt als einer), dazu jede Phase mit fertigen/gestarteten Agenten und ihrer Dauer. Fertige Workflows verschwinden.
- **Subagents:** laufende Subagents außerhalb von Workflows, mit Laufzeit.
- **Statuszeile:** `ctx 42% (422k/1M) · 5h 12% · wk 23% · ▶ <workflow> · <Phase> 1/2`

`/dash` öffnet das Panel. In breiten Terminals (ab 144 Spalten) öffnet es sich beim Start einer Session von selbst.

## Installieren

Am Prompt einer Claude-Code-Session im Terminal:

```
/plugin install dashboard --marketplace linuskemper/claude-dashboard
```

Dann `y`, um den Marketplace hinzuzufügen, und Enter für den Scope `user` (jede Session).

Aus einer Shell:

```
claude plugin install dashboard --marketplace linuskemper/claude-dashboard
```

In der Desktop-App, wo `/plugin` nicht läuft: auf + neben dem Prompt-Feld klicken, dann Plugins, Add marketplace mit `linuskemper/claude-dashboard`, dann Add plugin.

## Einstellen

Unter `/config` stehen vier Zeilen: Akzentfarbe, Balkenfarbe (Ampel oder Akzent), Hintergrund und ein innerer Rahmen.

Der Standard-Hintergrund ist `#282c34`. Ist dein Terminal anders, stell ihn auf `transparent`. Das Grau, das Claude Code unter ein angedocktes Panel legt, ist die Theme-Farbe `composerSidebarBackground`. Sie lässt sich mit einem eigenen Theme (`/theme` → New custom theme) überschreiben, z. B. in `~/.claude/themes/<name>.json`:

```json
{
  "name": "dark-ansi-282c34",
  "base": "dark-ansi",
  "overrides": { "composerSidebarBackground": "#282c34" }
}
```

## Hinweis

Die Workflow-Phasen liest der Mod aus Dateien, die Claude Code für jede Session unter `~/.claude/projects/` schreibt. Dieses Format ist nicht dokumentiert, ein Update von Claude Code kann diesen Teil brechen.
