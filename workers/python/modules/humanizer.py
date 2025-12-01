import dspy
from utils.gemini_client import get_lm_client

class HumanizeSignature(dspy.Signature):
    """
    Du bist ein Experte für akademisches Schreiben. Deine Aufgabe ist es, den Text so umzuschreiben, dass er natürlicher und menschlicher klingt, während ALLE faktischen Informationen und Zitationen erhalten bleiben.

    **KRITISCHE REGELN - ABSOLUT EINHALTEN:**
    1. ENTFERNE NIEMALS Zitationen oder Fußnoten (^1, ^2, etc.) - diese müssen EXAKT erhalten bleiben.
    2. ÄNDERE NIEMALS faktische Behauptungen, Daten, Zahlen oder Statistiken.
    3. ÄNDERE NIEMALS die Struktur des Dokuments (Kapitel, Abschnitte, Überschriften).
    4. ÄNDERE NIEMALS Autorennamen, Jahreszahlen oder Seitenzahlen in Zitationen.
    5. ÄNDERE NIEMALS den wissenschaftlichen Inhalt oder die Bedeutung.

    **WAS DU VERBESSERN SOLLST:**
    1. **Satz-Burstiness:** Mische aktiv kurze (5-10 Wörter), mittlere (15-20 Wörter) und lange (25-35 Wörter) Sätze.
    2. **Variation:** Verwende unterschiedliche Synonyme, variiere Satzanfänge.
    3. **Natürlicher Fluss:** Verbessere Übergänge zwischen Sätzen und Absätzen.
    4. **Entferne robotische Muster:** Ersetze repetitive Phrasen und vorhersehbare Strukturen.
    5. **Lesbarkeit:** Verbessere die Lesbarkeit ohne den akademischen Standard zu senken.

    **VERMEIDE DIESE KI-DISKURSMARKER:**
    - "zunächst", "ferner", "zusammenfassend", "insgesamt gesehen"
    - "es ist wichtig zu beachten", "darüber hinaus", "des Weiteren"
    - "in diesem Zusammenhang", "zudem", "außerdem"
    
    **VERWENDE STATTDESSEN:**
    - "In diesem Kontext", "Vor diesem Hintergrund", "Dabei zeigt sich"
    - "Hierbei", "In diesem Rahmen", "In der Folge", "Dementsprechend"

    **VERBOTENE WÖRTER (ENTFERNEN/ERSETZEN):**
    - "freilich", "gewiss", "sicherlich" (umgangssprachlich)
    - "natürlich" (als Füllwort), "selbstverständlich", "ohne Frage", "zweifellos"

    **PERSÖNLICHE PRONOMEN KORRIGIEREN:**
    - FALSCH: "Wir werden im nächsten Abschnitt darauf eingehen..."
    - RICHTIG: "Im nächsten Abschnitt wird darauf eingegangen..."
    - FALSCH: "Wir können feststellen, dass..."
    - RICHTIG: "Es lässt sich feststellen, dass..."

    **WICHTIG:**
    - Der Output muss EXAKT dieselbe Länge haben (±5% Wörter).
    - ALLE Fußnoten und Zitationen müssen im Output vorhanden sein.
    - Die wissenschaftliche Qualität muss erhalten bleiben.
    - Der Text soll wie von einem menschlichen Akademiker geschrieben klingen.
    """
    
    text = dspy.InputField(desc="The academic text to humanize")
    citations_metadata = dspy.InputField(desc="JSON metadata of all citations that MUST be preserved exactly")
    
    humanized_text = dspy.OutputField(desc="The humanized text with all citations preserved")


class ThesisHumanizer(dspy.Module):
    def __init__(self):
        super().__init__()
        self.humanize = dspy.ChainOfThought(HumanizeSignature)
    
    def forward(self, text: str, citations: list):
        # We pass the citations metadata so the model knows what to protect
        citations_str = json.dumps(citations, ensure_ascii=False) if citations else "[]"
        
        # Configure LM context for this call
        lm = get_lm_client()
        with dspy.context(lm=lm):
            return self.humanize(text=text, citations_metadata=citations_str)


# Need to import json for the forward method
import json
