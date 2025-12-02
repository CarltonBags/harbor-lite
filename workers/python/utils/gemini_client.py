import os
import dspy
from dotenv import load_dotenv

load_dotenv()

def get_lm_client():
    """Get a basic LM client using DSPy's built-in Gemini support via LiteLLM"""
    model_name = os.getenv('GENERATION_MODEL', 'gemini-2.5-pro-preview-06-05')
    api_key = os.getenv('GEMINI_KEY')
    
    # DSPy uses LiteLLM under the hood, which supports Gemini with the gemini/ prefix
    lm = dspy.LM(
        model=f"gemini/{model_name}",
        api_key=api_key,
        temperature=0.7,
        max_tokens=65536  # Allow long outputs for thesis generation
    )
    
    return lm

def get_lm_client_with_filesearch(filesearch_store_id: str):
    """
    Get an LM client for thesis generation.
    
    Note: DSPy's LiteLLM integration doesn't directly support Google's FileSearchStore.
    The FileSearchStore sources have already been uploaded and will be referenced
    in the prompt context. For RAG, we rely on the prompt including source information.
    
    The filesearch_store_id is logged for debugging but the actual retrieval
    happens via the research pipeline before generation.
    """
    if filesearch_store_id:
        print(f"Configuring LM with FileSearchStore: {filesearch_store_id}")
        print("Note: Sources from FileSearchStore should be included in prompt context")
    else:
        print("Warning: No FileSearchStore ID provided")
    
    return get_lm_client()
