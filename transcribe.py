import sys, json, whisper

model_name = sys.argv[2] if len(sys.argv) > 2 else 'small'
model = whisper.load_model(model_name)
result = model.transcribe(sys.argv[1], verbose=False)
print(json.dumps({'text': result['text'].strip(), 'language': result.get('language', '')}))
