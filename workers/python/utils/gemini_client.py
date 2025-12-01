import os
import dspy
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

class GeminiLM(dspy.LM):
    def __init__(self, model_name, api_key, filesearch_store_id=None, **kwargs):
        super().__init__(model=model_name)
        self.client = genai.Client(api_key=api_key)
        self.model_name = model_name
        self.filesearch_store_id = filesearch_store_id
        self.kwargs = kwargs

    def basic_request(self, prompt, **kwargs):
        # Merge kwargs
        config = {**self.kwargs, **kwargs}
        
        # Handle tools/resources if passed (custom handling for File Search)
        tool_config = config.pop('tool_config', None)
        tools = config.pop('tools', None)
        
        # Build the generation config
        gen_config = types.GenerateContentConfig(
            tools=tools,
            tool_config=tool_config,
            **config
        )
        
        # If we have a FileSearchStore, use it for RAG
        if self.filesearch_store_id:
            # The new google-genai SDK uses the retriever parameter
            # to attach a corpus/FileSearchStore for semantic retrieval
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=prompt,
                config=gen_config
            )
        else:
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=prompt,
                config=gen_config
            )
        
        return response

    def __call__(self, prompt, **kwargs):
        response = self.basic_request(prompt, **kwargs)
        # Extract text from response
        return [response.text]

def get_lm_client():
    """Get a basic LM client without FileSearchStore"""
    return GeminiLM(
        model_name=os.getenv('GENERATION_MODEL', 'gemini-2.0-flash-exp'),
        api_key=os.getenv('GEMINI_KEY'),
        temperature=0.7,
        max_output_tokens=65536  # Allow long outputs for thesis generation
    )

def get_lm_client_with_filesearch(filesearch_store_id: str):
    """
    Get an LM client configured with FileSearchStore for RAG.
    
    The FileSearchStore contains uploaded PDFs/documents that the AI
    should use as sources for generating the thesis.
    """
    if not filesearch_store_id:
        print("Warning: No FileSearchStore ID provided, using basic client")
        return get_lm_client()
    
    # Ensure store ID has correct format
    store_name = filesearch_store_id
    if not store_name.startswith('fileSearchStores/'):
        # Handle different formats the ID might come in
        if store_name.startswith('corpora/'):
            store_name = store_name.replace('corpora/', 'fileSearchStores/')
        elif '/' not in store_name:
            store_name = f'fileSearchStores/{store_name}'
    
    print(f"Configuring LM with FileSearchStore: {store_name}")
    
    return GeminiLM(
        model_name=os.getenv('GENERATION_MODEL', 'gemini-2.0-flash-exp'),
        api_key=os.getenv('GEMINI_KEY'),
        filesearch_store_id=store_name,
        temperature=0.7,
        max_output_tokens=65536  # Allow long outputs for thesis generation
    )
