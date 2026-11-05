# Intervalinator: Plan-Format (JSON)

Mit diesem Format exportiert und importiert die App Trainingspläne: unter **Profil → Trainingsplan exportieren / importieren** oder für einen einzelnen Tag über das Menü **⋯** des Tages. Eine Datei enthält nur den Plan, keine Kontodaten und keinen Trainingsverlauf.

## Beispiel

```json
{
  "format": "intervalinator-plan",
  "version": 1,
  "exportedAt": "2026-11-05T18:30:00.000Z",
  "defaults": {
    "setPauseSeconds": 60,
    "exercisePauseSeconds": 15,
    "groupSwitchSeconds": 10,
    "strengthRestSeconds": 120
  },
  "days": [
    {
      "name": "Superset",
      "type": "interval",
      "exercises": [
        { "name": "Aufwärmen", "muscle": "warmup", "sets": 1, "seconds": 60 },
        { "name": "Bankdrücken", "muscle": "chest", "group": "A", "sets": 3, "seconds": 40 },
        { "name": "Rudern", "muscle": "back", "group": "A", "sets": 3, "seconds": 30, "setPauseSeconds": 75 },
        { "name": "Curls", "muscle": "biceps", "sets": 2, "seconds": 30, "pauseAfterSeconds": 20 }
      ]
    },
    {
      "name": "Kraft A",
      "type": "strength",
      "exercises": [
        { "name": "Kniebeugen", "muscle": "legs", "sets": 3, "unit": "reps", "amount": 8, "weightKg": 60 },
        { "name": "Bankdrücken", "muscle": "chest", "sets": 3, "unit": "reps",
          "setPlan": [ { "amount": 12, "weightKg": 40 }, { "amount": 10, "weightKg": 45 }, { "amount": 8, "weightKg": 50 } ] },
        { "name": "Plank", "muscle": "abs", "sets": 2, "unit": "seconds", "amount": 45, "weightKg": 0 }
      ]
    }
  ]
}
```

## Felder

**Datei**

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `format` | ja | Immer `intervalinator-plan` |
| `version` | ja | Formatversion, aktuell `1` |
| `days` | ja | Liste der Trainingstage |
| `exportedAt` | nein | Zeitpunkt des Exports |
| `defaults` | nein | Standardpausen in Sekunden, siehe unten |

**Tag**

| Feld | Bedeutung |
|---|---|
| `name` | Name des Tages |
| `type` | `interval` (Timer gibt die Zeiten vor) oder `strength` (Sätze abhaken) |
| `exercises` | Übungen in der Reihenfolge des Ablaufs |

**Übung**

| Feld | Gilt für | Bedeutung |
|---|---|---|
| `name` | alle | Name der Übung |
| `muscle` | alle | `warmup`, `chest`, `back`, `shoulders`, `biceps`, `triceps`, `legs`, `abs`, `fullbody`, `cardio`, `stretch` oder `other` |
| `sets` | alle | Sätze, in einer Gruppe die Runden (1–20) |
| `group` | alle | Beliebige Kennung, zum Beispiel `A`. Direkt aufeinanderfolgende Übungen mit gleicher Kennung laufen im Wechsel (a-b-a-b) |
| `setPauseSeconds` | alle | Eigene Pause nach einem Satz. In einer Gruppe: Pause nach dieser Übung innerhalb der Runde, bei der letzten Übung nach der Runde |
| `seconds` | Intervall | Dauer pro Satz |
| `pauseAfterSeconds` | Intervall | Eigene Pause nach der Übung, bei Gruppen an der letzten Übung |
| `unit` | Kraft | `reps` (Wiederholungen) oder `seconds` |
| `amount` | Kraft | Wiederholungen oder Sekunden pro Satz |
| `weightKg` | Kraft | Gewicht in kg, `0` für ohne Gewicht |
| `setPlan` | Kraft | Statt `amount` und `weightKg`: eigene Werte pro Satz. Die Länge bestimmt die Anzahl der Sätze |

**Standardpausen (`defaults`)**

| Feld | Bedeutung |
|---|---|
| `setPauseSeconds` | Zwischen zwei Sätzen, auch nach einer Gruppen-Runde |
| `exercisePauseSeconds` | Zwischen zwei Übungen |
| `groupSwitchSeconds` | Zwischen zwei Übungen einer Gruppe |
| `strengthRestSeconds` | Pausen-Empfehlung im Krafttraining |

## Import

- **Als neue Tage hinzufügen:** Der bestehende Plan bleibt erhalten. Tage mit gleichem Namen bekommen einen Zusatz wie „(2)“. Weichen die Standardpausen der Datei von den eigenen ab, werden sie an den importierten Übungen als eigene Werte festgehalten.
- **Aktuellen Plan ersetzen:** Tage und Standardpausen werden überschrieben. Das lässt sich nicht rückgängig machen.

Beim Import prüft die App jede Datei: Werte außerhalb der Grenzen werden angepasst, eine unbekannte Muskelgruppe wird zu `other`, und in einer Gruppe gilt die Rundenzahl der ersten Übung.
