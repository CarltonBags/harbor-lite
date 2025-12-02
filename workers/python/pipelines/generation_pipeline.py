from modules.generator import ThesisGenerator
from modules.citation_extractor import CitationExtractor
from modules.quality_checker import QualityChecker

class ThesisGenerationPipeline:
    def run(self, job_data):
        # 1. Parse input
        outline = job_data['outline']
        research_question = job_data['research_question']
        specs = job_data['specifications']
        mandatory_sources = job_data.get('mandatory_sources', [])
        filesearch_store_id = job_data['filesearch_store_id']
        available_sources = job_data.get('available_sources', [])  # Real sources from research!
        
        print(f"Starting generation for thesis: {specs.get('title', 'Untitled')}")
        print(f"Available sources from research: {len(available_sources)}")
        
        # 2. Generate thesis
        generator = ThesisGenerator()
        # DSPy modules return a Prediction object, access fields via dot notation
        result = generator(
            outline=outline, 
            research_question=research_question, 
            specs=specs, 
            mandatory_sources=mandatory_sources, 
            filesearch_store_id=filesearch_store_id,
            available_sources=available_sources  # Pass real sources!
        )
        
        thesis_text = result.thesis_text
        
        # 3. Extract citations
        extractor = CitationExtractor()
        citation_style = specs.get('citationStyle', 'apa')
        citations = extractor(thesis_text=thesis_text, citation_style=citation_style)
        
        # 4. Validate
        checker = QualityChecker()
        validation = checker.validate(thesis_text, outline, specs, mandatory_sources, citations)
        
        # 5. Return
        return {
            "thesis_text": thesis_text,
            "citations": citations,
            "validation": validation,
            "word_count": validation['word_count']
        }
