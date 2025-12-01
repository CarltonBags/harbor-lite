from modules.humanizer import ThesisHumanizer
from utils.zerogpt import ZeroGPTClient
import time

class HumanizationPipeline:
    def run(self, thesis_text, citations, max_iterations=5, target_score=70):
        humanizer = ThesisHumanizer()
        zerogpt = ZeroGPTClient()
        
        current_text = thesis_text
        iteration = 0
        best_score = 0
        best_text = current_text
        
        print(f"Starting humanization loop. Target score: {target_score}%")
        
        # Initial check
        initial_check = zerogpt.check(current_text)
        current_score = initial_check['human_percentage']
        print(f"Initial ZeroGPT Score: {current_score}%")
        
        if current_score >= target_score:
            return {
                "humanized_text": current_text,
                "final_score": initial_check,
                "iterations": 0,
                "history": [{"iteration": 0, "score": current_score}]
            }
            
        history = [{"iteration": 0, "score": current_score}]
        
        while iteration < max_iterations:
            iteration += 1
            print(f"Humanization iteration {iteration}/{max_iterations}...")
            
            # Humanize
            result = humanizer(text=current_text, citations=citations)
            new_text = result.humanized_text
            
            # Check score
            check_result = zerogpt.check(new_text)
            new_score = check_result['human_percentage']
            print(f"Iteration {iteration} Score: {new_score}%")
            
            history.append({"iteration": iteration, "score": new_score})
            
            # Update current text
            current_text = new_text
            
            # Track best result
            if new_score > best_score:
                best_score = new_score
                best_text = new_text
            
            if new_score >= target_score:
                print(f"Target score reached! ({new_score}%)")
                break
                
            # Small delay to avoid rate limits if any
            time.sleep(1)
            
        # If we didn't reach target, return best result
        final_text = current_text if current_score >= target_score else best_text
        final_score_val = current_score if current_score >= target_score else best_score
        
        return {
            "humanized_text": final_text,
            "final_score": {"human_percentage": final_score_val},
            "iterations": iteration,
            "history": history
        }
