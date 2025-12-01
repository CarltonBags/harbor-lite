import dspy
import json
from typing import List, Dict, Any
from pydantic import BaseModel, Field
from utils.gemini_client import get_lm_client

class Citation(BaseModel):
    id: str = Field(description="Unique identifier for the citation (e.g., 'cite1', 'cite2')")
    authors: List[str] = Field(description="List of author names")
    year: int = Field(description="Year of publication")
    title: str = Field(description="Title of the work")
    journal: str = Field(description="Journal name or Publisher", default="")
    doi: str = Field(description="DOI if available", default="")
    pages: str = Field(description="Page numbers cited (e.g., '45-67')", default="")
    url: str = Field(description="URL if available", default="")

class ExtractCitationsSignature(dspy.Signature):
    """
    Analysiere den Thesis-Text und extrahiere ALLE verwendeten Zitationen.
    Gib eine Liste strukturierter Zitations-Metadaten zurück.
    Inkludiere NUR Quellen, die tatsächlich im Text zitiert werden.

    **AUFGABE:**
    1. Finde ALLE Zitationen im Text (Fußnoten ^1, ^2 oder In-Text wie (Autor, Jahr)).
    2. Extrahiere die vollständigen Metadaten für jede Quelle.
    3. Gib die Daten als JSON-Array zurück.

    **WICHTIG:**
    - Extrahiere NUR Quellen, die tatsächlich im Text zitiert werden.
    - Erfinde KEINE Quellen oder Metadaten.
    - Wenn Informationen fehlen, verwende leere Strings.
    - Seitenzahlen sind KRITISCH - extrahiere sie wenn vorhanden.

    **FORMAT FÜR JEDEN EINTRAG:**
    {
        "id": "cite1",
        "authors": ["Müller, J.", "Schmidt, A."],
        "year": 2023,
        "title": "Titel der Arbeit",
        "journal": "Name der Zeitschrift",
        "doi": "10.1234/example",
        "pages": "45-67",
        "url": "https://..."
    }

    **ZITATIONSSTILE ERKENNEN:**
    - APA/Harvard: (Autor, Jahr, S. XX) oder (Autor, Jahr)
    - Deutsche Zitierweise: Fußnoten ^1, ^2 mit [^1]: Autor, Titel, Jahr, S. XX
    - MLA: (Autor XX)
    """
    
    thesis_text = dspy.InputField(desc="The full thesis text containing citations")
    citation_style = dspy.InputField(desc="The citation style used: 'apa', 'harvard', 'mla', or 'deutsche-zitierweise'")
    
    citations = dspy.OutputField(desc="JSON array of citation objects with id, authors, year, title, journal, doi, pages, url", prefix="```json\n[")


class CitationExtractor(dspy.Module):
    def __init__(self):
        super().__init__()
        self.extract = dspy.ChainOfThought(ExtractCitationsSignature)
    
    def forward(self, thesis_text: str, citation_style: str) -> List[Dict[str, Any]]:
        # Get LM client
        lm = get_lm_client()
        
        with dspy.context(lm=lm):
            result = self.extract(thesis_text=thesis_text, citation_style=citation_style)
        
        # Parse the JSON output
        try:
            # Clean up markdown code blocks if present
            json_str = result.citations
            if json_str.startswith("```json"):
                json_str = json_str.replace("```json", "").replace("```", "")
            elif json_str.startswith("```"):
                json_str = json_str.replace("```", "")
            
            # Remove trailing brackets that might be duplicated
            json_str = json_str.strip()
            if not json_str.startswith("["):
                json_str = "[" + json_str
            if not json_str.endswith("]"):
                # Find the last complete object
                last_brace = json_str.rfind("}")
                if last_brace != -1:
                    json_str = json_str[:last_brace + 1] + "]"
            
            citations_data = json.loads(json_str)
            print(f"Extracted {len(citations_data)} citations")
            return citations_data
        except Exception as e:
            print(f"Error parsing citation JSON: {e}")
            print(f"Raw output: {result.citations[:500]}...")
            return []
