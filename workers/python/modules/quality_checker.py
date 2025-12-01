from typing import List, Dict, Any
import re

class QualityChecker:
    def validate(self, thesis_text: str, outline: List[Any], specs: Dict[str, Any], mandatory_sources: List[str], citations: List[Dict[str, Any]]) -> Dict[str, Any]:
        
        # 1. Word Count Check
        word_count = len(thesis_text.split())
        target_length = specs.get('targetLength', 0)
        # Handle length unit conversion if needed (assuming targetLength is words here, or converted before)
        # If unit is pages, convert to words (approx 250-300 words/page)
        if specs.get('lengthUnit') == 'pages':
            target_length = target_length * 300
            
        max_length = int(target_length * 1.10)
        min_length = int(target_length * 0.90)
        
        word_count_valid = word_count <= max_length # We are strict on max, maybe lenient on min?
        # User said: "words calculated are nopt exceeded by more than 10%"
        
        # 2. Mandatory Sources Check
        cited_sources = set()
        for cit in citations:
            if 'title' in cit:
                cited_sources.add(cit['title'].lower())
            if 'doi' in cit and cit['doi']:
                cited_sources.add(cit['doi'].lower())
        
        missing_mandatory = []
        for source in mandatory_sources:
            # Source string might be title or DOI
            # We need to check if it's in the citations
            # This is a fuzzy check
            found = False
            source_lower = source.lower()
            for cited in cited_sources:
                if source_lower in cited or cited in source_lower:
                    found = True
                    break
            if not found:
                # Also check in text directly as fallback
                if source_lower in thesis_text.lower():
                    found = True
                
            if not found:
                missing_mandatory.append(source)
        
        # 3. Forbidden Elements Check
        forbidden_patterns = [
            r"!\[.*?\]\(.*?\)", # Images
            r"\|.*\|.*\|", # Markdown tables
            r"<table>", # HTML tables
            r"Here is a table",
            r"As an AI",
            r"I cannot create"
        ]
        
        errors = []
        for pattern in forbidden_patterns:
            if re.search(pattern, thesis_text, re.IGNORECASE):
                errors.append(f"Found forbidden pattern: {pattern}")
        
        if not word_count_valid:
            errors.append(f"Word count {word_count} exceeds limit {max_length}")
            
        if missing_mandatory:
            errors.append(f"Missing mandatory sources: {missing_mandatory}")
            
        return {
            "valid": len(errors) == 0,
            "word_count": word_count,
            "word_count_within_limit": word_count_valid,
            "missing_mandatory_sources": missing_mandatory,
            "errors": errors
        }
