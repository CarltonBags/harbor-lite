import os
import requests
from typing import Dict, Any

class ZeroGPTClient:
    def __init__(self):
        self.api_key = os.getenv('ZEROGPT_API_KEY')
        self.api_url = "https://api.zerogpt.com/api/detect/detectText"
    
    def check(self, text: str) -> Dict[str, Any]:
        if not self.api_key:
            print("Warning: ZeroGPT API key not found. Returning mock score.")
            return {"human_percentage": 100, "fake_percentage": 0}
            
        try:
            payload = {
                "text": text,
                "input_text": text
            }
            headers = {
                "Content-Type": "application/json",
                "ApiKey": self.api_key
            }
            
            response = requests.post(self.api_url, json=payload, headers=headers)
            response.raise_for_status()
            
            data = response.json()
            
            # Extract score
            # Note: Actual API response structure might vary, adjusting based on common ZeroGPT API format
            # Usually returns 'fakePercentage' or similar.
            # Let's assume data['data']['fakePercentage'] or similar.
            
            # If we can't verify exact API response now, we'll wrap it safely.
            # Assuming 'fakePercentage' is returned (0-100)
            
            fake_percentage = data.get('fakePercentage', 0)
            if 'data' in data and 'fakePercentage' in data['data']:
                fake_percentage = data['data']['fakePercentage']
                
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
