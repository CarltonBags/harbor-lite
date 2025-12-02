"""
Configuration for DSPy thesis generation
"""
import os
from dotenv import load_dotenv

load_dotenv()

# API Keys
GEMINI_API_KEY = os.getenv('GEMINI_KEY')
RAPIDAPI_KEY = os.getenv('RAPIDAPI_KEY')  # Used for ZeroGPT via RapidAPI

# Model Configuration
GENERATION_MODEL = 'gemini-2.5-pro'  # or gemini-2.5-pro for better quality
HUMANIZATION_MODEL = 'gemini-2.5-pro'

# Generation Settings
MAX_OUTPUT_TOKENS = 400000  # Gemini 2.0 Flash supports up to 8k output
TEMPERATURE = 0.7

# Quality Control
MIN_ZEROGPT_SCORE = 70  # Minimum human percentage
MAX_HUMANIZATION_ITERATIONS = 5
WORD_COUNT_TOLERANCE = 0.10  # ±10%

# FileSearchStore Settings
FILESEARCH_CHUNK_SIZE = 512
FILESEARCH_OVERLAP = 50

# Citation Styles
SUPPORTED_CITATION_STYLES = ['apa', 'harvard', 'mla', 'deutsche-zitierweise']
