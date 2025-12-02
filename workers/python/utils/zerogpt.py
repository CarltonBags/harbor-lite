import os
import requests
from typing import Dict, Any

class ZeroGPTClient:
    def __init__(self):
        # Try RAPIDAPI_KEY first (used in frontend), fall back to ZEROGPT_API_KEY
        self.api_key = os.getenv('RAPIDAPI_KEY') or os.getenv('ZEROGPT_API_KEY')
        self.api_url = "https://zerogpt.p.rapidapi.com/api/v1/detectText"
    
    def check(self, text: str) -> Dict[str, Any]:
        if not self.api_key:
            print("Warning: ZeroGPT API key not found. Returning mock score.")
            return {"human_percentage": 100, "fake_percentage": 0}
            
        try:
            payload = {
                "input_text": text
            }
            headers = {
                "Content-Type": "application/json",
                "X-RapidAPI-Key": self.api_key,
                "X-RapidAPI-Host": "zerogpt.p.rapidapi.com"
            }
            
            response = requests.post(self.api_url, json=payload, headers=headers)
            response.raise_for_status()
            
            data = response.json()
            
            # RapidAPI ZeroGPT response format:
            # { "success": true, "data": { "is_human_written": 85, "is_gpt_generated": 15, ... } }
            
            if data.get('success') and 'data' in data:
                human_percentage = data['data'].get('is_human_written', 0)
                fake_percentage = data['data'].get('is_gpt_generated', 0)
            else:
                # Fallback for other formats
                fake_percentage = data.get('fakePercentage', 0)
                human_percentage = 100 - fake_percentage
            
            return {
                "human_percentage": human_percentage,
                "fake_percentage": fake_percentage,
                "raw": data
            }
            
        except Exception as e:
            print(f"Error calling ZeroGPT: {e}")
            # Fallback to high human score to avoid blocking if API fails
            return {"human_percentage": 100, "fake_percentage": 0, "error": str(e)}
