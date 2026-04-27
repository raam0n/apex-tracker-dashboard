import os
import base64
import requests
import glob
import sys

# --- Configuration ---
API_URL = "http://127.0.0.1:1234/v1/chat/completions"
# Set this to the folder containing your screenshots. Use "." for the current directory.
DIRECTORY = "." 

def encode_image(image_path):
    """Encodes the image to base64 to send over the local API."""
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def process_single_image(img_path):
    """Processes a single image and saves the result to a .txt file."""
    if not os.path.exists(img_path):
        print(f"Error: File {img_path} not found.")
        return

    print(f"Processing: {img_path}")
    base64_image = encode_image(img_path)

    # Standard OpenAI-compatible vision payload
    payload = {
        "model": "local-model", # LM Studio usually ignores this if only one model is loaded
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Extract the names (There are 3 cards, each one has the name on the top left side, it should be 'Invisible Drax', 'ram0n', 'El amigable tio Pencil' and '[SL] RayMalubi' in these images), the Kills/Assists/Knocks from each (each should be 3 numbers separated with / below that), the Damage Dealt (it should be the number below that) and the Revive Given (the number below that as well), and finally on top of the cards on the right side it says 'SQUAD PLACED #' and a number and the 'TOTAL KILLS WITH SQUAD' and a number as well which both should be stored as well. Output ONLY the extracted text and the corresponding legend without any conversational filler, markdown formatting (do NOT use ** for bold), or explanations."
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}"
                        }
                    }
                ]
            }
        ],
        "temperature": 0.1, # Low temperature for more deterministic/accurate text extraction
        "max_tokens": 2000
    }

    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(API_URL, headers=headers, json=payload)
        response.raise_for_status() # Check for HTTP errors
        result = response.json()

        extracted_text = result['choices'][0]['message']['content']

        # Construct the .txt file path
        base_name = os.path.splitext(img_path)[0]
        txt_path = f"{base_name}.txt"

        # Save the text
        with open(txt_path, "w", encoding="utf-8") as text_file:
            text_file.write(extracted_text)

        print(f"Success! Saved to: {txt_path}\n")

    except requests.exceptions.RequestException as req_err:
        print(f"API Connection Error on {img_path}: {req_err}\n")
    except KeyError as key_err:
        print(f"Unexpected response format on {img_path}. Error: {key_err}\n")
        if 'response' in locals():
            print("Raw response:", response.text)

def process_images(directory):
    # Grab all jpg, jpeg, and png files (handling case sensitivity)
    extensions = ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG')
    image_paths = []
    for ext in extensions:
        image_paths.extend(glob.glob(os.path.join(directory, ext)))
    
    if not image_paths:
        print(f"No screenshots found in {directory}.")
        return

    print(f"Found {len(image_paths)} images. Starting OCR process...")
    for img_path in image_paths:
        process_single_image(img_path)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        # If an argument is passed, process only that file
        process_single_image(sys.argv[1])
    else:
        # Otherwise, process all images in the directory
        process_images(DIRECTORY)