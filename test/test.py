import requests

ip = '23.236.48.55'
apiKey = '6e4132762cb8cf29'
url = f'https://api.ipapi.is?q={ip}&key={apiKey}'

for i in range(150):
    response = requests.get(url)
    print(response.json())
