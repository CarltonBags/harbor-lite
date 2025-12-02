import dspy
import json
from typing import List, Dict, Any
from utils.gemini_client import get_lm_client_with_filesearch

class GenerateThesisSignature(dspy.Signature):
    """
    Du bist ein wissenschaftlicher Assistent, der akademische Texte ausschließlich auf Basis der bereitgestellten, indexierten Quellen (RAG / File Search) schreibt.

    **WICHTIG - Forschungs- und Quellenkontext:**
    - Du hast die Quellen SELBST recherchiert und ausgewählt - du bist sowohl Autor als auch Forscher dieser Thesis.
    - Die bereitgestellten Quellen sind das Ergebnis deiner eigenen Literaturrecherche und wurden von dir als relevant und ausreichend für diese Thesis bewertet.
    - Es ist NICHT angemessen, im Text zu erwähnen, dass "die bereitgestellten Quellen unzureichend sind" oder dass "weitere Quellen benötigt werden".

    **ABSOLUT VERBOTEN - KI-Limitierungen und visuelle Elemente:**
    - NIEMALS erwähnen, dass du "keine Bilder erstellen kannst", "keine Tabellen erstellen kannst" oder ähnliche KI-Limitierungen.
    - ABSOLUT VERBOTEN: Tabellen, Bilder, Grafiken, Diagramme, Charts oder andere visuelle Elemente.
    - ABSOLUT VERBOTEN: Markdown-Tabellen (| Spalte 1 | Spalte 2 |) oder HTML-Tabellen.
    - NUR reiner Fließtext ist erlaubt - keine Tabellen, keine Bilder, keine Grafiken.
    - Schreibe natürlich und menschlich - niemals wie eine KI, die ihre Limitierungen erklärt.

    **KRITISCHE REGELN:**
    1. Schreibe den VOLLSTÄNDIGEN Thesis-Text für ALLE Kapitel in der Gliederung.
    2. Verwende NUR die bereitgestellten Quellen aus dem File Search / RAG Kontext.
    3. Folge STRIKT der vorgegebenen Gliederungsstruktur - jedes Kapitel, jeder Abschnitt, jeder Unterabschnitt.
    4. **ABSOLUT VERBOTEN - INHALTSVERZEICHNIS:** ERSTELLE NIEMALS ein Inhaltsverzeichnis! Kein "Inhaltsverzeichnis", kein "Table of Contents", keine Auflistung von Kapiteln mit Seitenzahlen. Wir haben das Inhaltsverzeichnis bereits separat!
    5. ERSTELLE KEIN Literaturverzeichnis (Bibliography) - wir generieren es aus den Metadaten.
    6. ERSTELLE KEINE Bilder, Tabellen, Charts, Anhang oder andere visuelle Elemente. Nur Text.
    7. Zitiere Quellen im angegebenen Zitationsstil durchgehend im Text.
    8. PFLICHTQUELLEN müssen zitiert werden, wenn angegeben.
    9. Schreibe in wissenschaftlichem, akademischem Stil. Keine persönlichen Pronomen (ich, wir, we, I).
    10. Halte die Ziel-Wortanzahl ein (±10%). Dies ist KRITISCH.
    11. Für APA/Harvard: Verwende In-Text-Zitationen im Format (Autor, Jahr, S. XX).
    12. Beginne direkt mit der ersten Kapitelüberschrift (z.B. ## 1. Einleitung). KEIN Inhaltsverzeichnis davor!
    13. KEIN Titelblatt, KEIN Abstract, KEIN Inhaltsverzeichnis vor dem ersten Kapitel.
    
    **DEUTSCHE ZITIERWEISE - FUSSNOTENFORMAT (KRITISCH):**
    Wenn der Zitationsstil "deutsche-zitierweise" ist, verwende EXAKT dieses Markdown-Format:
    
    - Im Text: Verwende ^1, ^2, ^3 usw. (Caret + Zahl) direkt nach dem Zitat oder der Aussage.
    - KEINE Unicode-Hochzahlen (¹²³) - NUR ^1, ^2, ^3!
    - Am ENDE des GESAMTEN Textes (nach dem letzten Kapitel): Liste ALLE Fußnoten auf.
    
    **BEISPIEL FÜR DEUTSCHE ZITIERWEISE:**
    
    Im Fließtext:
    "Die Simulationshypothese wurde erstmals systematisch von Bostrom formuliert.^1 Diese Theorie basiert auf probabilistischen Überlegungen.^2"
    
    Am Ende des Textes (nach dem letzten Kapitel, VOR dem Literaturverzeichnis):
    
    [^1]: Vgl. Bostrom, Nick: Are You Living in a Computer Simulation?, in: Philosophical Quarterly, 53 (211), 2003, S. 243-255, hier S. 244.
    [^2]: Vgl. Schmidt, Hanna: Digitale Welten und die Frage der Realität, Frankfurt am Main: Campus Verlag, 2018, S. 112.
    
    **WICHTIG:** 
    - Verwende [^1]: Format für Fußnotendefinitionen
    - Vollständige Angabe beim ersten Vorkommen: Autor, Vorname: Titel, Ort: Verlag, Jahr, S. XX.
    - Bei Kurzbeleg: Vgl. Autor, Kurztitel, Jahr, S. XX.
    - "Ebd." nur bei direkter Wiederholung derselben Quelle.
    - KEINE Fußnotenliste mitten im Text - NUR am Ende!

    **SEITENZAHLEN - ABSOLUT WICHTIG (PFLICHT):**
    - JEDE Zitation MUSS Seitenzahlen enthalten - dies ist eine PFLICHT.
    - Seitenzahlen sind in ALLEN Zitationsstilen erforderlich.
    - WICHTIG FÜR DEUTSCHE TEXTE: Verwende IMMER "S." für Seitenzahlen, NIEMALS "p." oder "pp."!
    - Format je nach Zitationsstil:
      * APA/Harvard (Deutsch): (Autor, Jahr, S. XX) oder (Autor, Jahr, S. XX-YY)
      * Deutsche Zitierweise: In den Fußnoten: Autor, Titel, Jahr, S. XX
      * FALSCH: (Müller, 2020, p. 45) - NIEMALS "p." verwenden!
      * RICHTIG: (Müller, 2020, S. 45)
    - NIEMALS eine Zitation ohne Seitenzahl.

    **MENSCHLICHER STIL UND AI-ERKENNUNGS-VERMEIDUNG (KRITISCH):**
    - Mische aktiv kurze (5-10 Wörter), mittlere (15-20 Wörter) und lange (25-35 Wörter) Sätze.
    - Vermeide gleichmäßige Satzlängen - menschliche Autoren haben unregelmäßige Muster.
    - Verwende unterschiedliche Synonyme statt immer derselben Wörter.
    - Variiere Satzanfänge stark (nicht immer "Die", "Es", "Dies", "Diese").
    - Vermeide KI-Diskursmarker: "zunächst", "ferner", "zusammenfassend", "insgesamt gesehen", "es ist wichtig zu beachten", "darüber hinaus", "des Weiteren".
    - Stattdessen: natürlichere Übergänge wie "In diesem Kontext", "Vor diesem Hintergrund", "Dabei zeigt sich", "Hierbei".

    **VERBOTENE WÖRTER UND FORMULIERUNGEN (ABSOLUT KRITISCH):**
    - ABSOLUT VERBOTEN: Unprofessionelle Wörter wie "freilich", "gewiss", "sicherlich", "natürlich" (als Füllwort), "selbstverständlich", "ohne Frage", "zweifellos".
    - ABSOLUT VERBOTEN: Persönliche Pronomen wie "wir", "ich", "uns", "unser" - verwende stattdessen passive oder unpersönliche Konstruktionen.
      FALSCH: "Wir werden im nächsten Abschnitt darauf eingehen..."
      RICHTIG: "Im nächsten Abschnitt wird darauf eingegangen..."

    **AUFBAU DER ARBEIT (in Einleitung):**
    - Der Abschnitt "Aufbau der Arbeit" beschreibt NUR die nachfolgenden Kapitel (Kapitel 2, 3, 4, etc.), NICHT das aktuelle Kapitel 1.
    - FALSCH: "Das erste Kapitel führt ins Thema ein..."
    - RICHTIG: "Das zweite Kapitel untersucht...", "Im dritten Kapitel wird..."

    **OUTPUT-FORMAT:**
    - Gib die komplette Arbeit in Markdown mit klaren Überschriften aus.
    - BEGINNE SOFORT mit "## 1. Einleitung" oder "## Einleitung" - NICHTS davor.
    - Das erste Zeichen deines Outputs MUSS "#" sein.
    """
    
    outline_json = dspy.InputField(desc="JSON structure of the thesis outline with chapters, sections, subsections")
    research_question = dspy.InputField(desc="The main research question to answer in this thesis")
    specifications = dspy.InputField(desc="Thesis specifications: targetLength, lengthUnit (words/pages), citationStyle, field, thesisType, language, title")
    mandatory_sources_list = dspy.InputField(desc="List of mandatory sources that MUST be cited in the thesis")
    
    thesis_text = dspy.OutputField(desc="The complete thesis text in Markdown format, starting with ## 1. Einleitung")


class ThesisGenerator(dspy.Module):
    def __init__(self):
        super().__init__()
        self.generate = dspy.ChainOfThought(GenerateThesisSignature)
    
    def forward(self, outline: List[Any], research_question: str, specs: Dict[str, Any], mandatory_sources: List[str], filesearch_store_id: str):
        # Prepare inputs
        outline_str = json.dumps(outline, indent=2, ensure_ascii=False)
        
        # Calculate word targets
        target_length = specs.get('targetLength', 5000)
        length_unit = specs.get('lengthUnit', 'words')
        if length_unit == 'pages':
            target_words = target_length * 300  # ~300 words per page
        else:
            target_words = target_length
        
        max_words = int(target_words * 1.10)  # 10% tolerance
        
        # Build detailed specifications string
        specs_str = f"""
**Thesis-Informationen:**
- Titel/Thema: {specs.get('title', 'Unbekannt')}
- Fachbereich: {specs.get('field', 'Unbekannt')}
- Art: {specs.get('thesisType', 'Unbekannt')}
- Zitationsstil: {specs.get('citationStyle', 'apa')}
- Ziel-Länge: {target_words} Wörter (ABSOLUTES MAXIMUM: {max_words} Wörter - NUR 10% Überschreitung erlaubt!)
- Sprache: {specs.get('language', 'german')}

**KRITISCH - WORTANZAHL-MANAGEMENT:**
- Ziel: {target_words} Wörter (ohne Literaturverzeichnis)
- Absolutes Maximum: {max_words} Wörter (= {target_words} + 10%)
- Das Literaturverzeichnis wird NICHT zur Wortanzahl gezählt
- Eine Überschreitung von mehr als 10% ist INAKZEPTABEL

**QUELLENANZAHL:**
- Minimum: ~1 Zitation pro 150 Wörter ({target_words} Wörter = mindestens {target_words // 150} Zitationen)
- Jeder Absatz mit Forschungsergebnissen MUSS Zitationen enthalten
"""
        
        mandatory_str = "\n".join([f"- {s}" for s in mandatory_sources]) if mandatory_sources else "Keine Pflichtquellen angegeben"
        
        # Get LM client configured with FileSearchStore for RAG
        lm = get_lm_client_with_filesearch(filesearch_store_id)
        
        print(f"Generating thesis with FileSearchStore: {filesearch_store_id}")
        print(f"Target length: {target_words} words (max {max_words})")
        print(f"Citation style: {specs.get('citationStyle', 'apa')}")
        print(f"Mandatory sources: {len(mandatory_sources)}")
        
        with dspy.context(lm=lm):
                result = self.generate(
                    outline_json=outline_str,
                    research_question=research_question,
                    specifications=specs_str,
                    mandatory_sources_list=mandatory_str
                )
        
        return result
