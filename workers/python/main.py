"""
Main entry point for Python DSPy thesis generation
Receives commands from Node.js worker and executes appropriate pipeline

IMPORTANT: Only JSON output goes to stdout. All logs go to stderr.
The Node.js PythonBridge expects stdout to contain ONLY valid JSON.
"""
import sys
import json
import logging

# Configure logging to stderr so it doesn't interfere with JSON output
logging.basicConfig(
    level=logging.INFO,
    format='[Python] %(levelname)s: %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)

# Redirect all print statements from modules to stderr
def log_print(*args, **kwargs):
    """Redirect print to stderr for logging"""
    print(*args, file=sys.stderr, **kwargs)

# Patch print in imported modules
import builtins
original_print = builtins.print
builtins.print = lambda *args, **kwargs: original_print(*args, **{**kwargs, 'file': sys.stderr}) if kwargs.get('file') is None else original_print(*args, **kwargs)

from pipelines.generation_pipeline import ThesisGenerationPipeline
from pipelines.humanization_pipeline import HumanizationPipeline

def main():
    if len(sys.argv) < 3:
        # Output error as JSON to stdout (this is expected)
        original_print(json.dumps({"error": "Usage: python main.py <pipeline_name> <json_data>"}))
        sys.exit(1)
    
    pipeline_name = sys.argv[1]
    logger.info(f"Starting pipeline: {pipeline_name}")
    
    try:
        data = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        original_print(json.dumps({"error": f"Invalid JSON data: {str(e)}"}))
        sys.exit(1)
    
    try:
        if pipeline_name == 'generation':
            logger.info("Running generation pipeline...")
            pipeline = ThesisGenerationPipeline()
            result = pipeline.run(data)
            logger.info("Generation pipeline complete")
            # Output result as JSON to stdout
            original_print(json.dumps(result))
        
        elif pipeline_name == 'humanization':
            logger.info("Running humanization pipeline...")
            pipeline = HumanizationPipeline()
            result = pipeline.run(
                data['thesis_text'],
                data['citations'],
                data.get('max_iterations', 5),
                data.get('target_score', 70)
            )
            logger.info("Humanization pipeline complete")
            original_print(json.dumps(result))
        
        else:
            original_print(json.dumps({"error": f"Unknown pipeline: {pipeline_name}"}))
            sys.exit(1)
    
    except Exception as e:
        logger.error(f"Pipeline error: {str(e)}", exc_info=True)
        original_print(json.dumps({"error": str(e), "type": type(e).__name__}))
        sys.exit(1)

if __name__ == '__main__':
    main()
