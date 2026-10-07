"""Derive Pi runtime models and picker rows from the existing fleet catalog."""
import copy
import re
from configure import LEVELS, direct_providers

CANONICAL = {'Opus','Sonnet','Fable','Astra','Sol','Luna','Web Extra','Web Pro'}
LEVEL_LABELS = {'off':'Off','minimal':'Minimal','low':'Low','medium':'Medium','high':'High','xhigh':'Extra High','max':'Max'}


def derive(providers, pi):
    sources = pi.get('catalogSources', ['claude', 'codex'])
    runtime = copy.deepcopy(pi['runtime'])
    if 'models' in runtime:
        raise ValueError('Pi models must derive from the fleet catalog, not a second list')
    namespace = runtime.get('modelProvider', 'fleet')
    rows=[]; models=[]; labels=set()
    default_source=pi.get('defaultSourceProvider','codex')
    default=None
    for provider in sources:
        for source in providers.get(provider, {}).get('models', []):
            label=source['label']
            if label not in CANONICAL or label in labels:
                raise ValueError('Pi catalog requires unique canonical model labels')
            labels.add(label)
            api=source.get('api', 'anthropic-messages' if provider=='claude' else 'openai-responses')
            model_id=source.get('apiModelId',source['id'])
            row=copy.deepcopy(source);row['id']=namespace+'/'+model_id;row.pop('api',None);row.pop('apiModelId',None)
            row['isDefault']=False
            options=[option for option in source.get('thinkingOptions', []) if option['id'] in {'off','minimal','low','medium','high','xhigh','max'}]
            if source['id'].startswith('chatgpt-web/'):options=[]
            row['thinkingOptions']=options
            row.pop('defaultThinkingOptionId',None)
            model={'id':model_id,'name':label,'api':api,'reasoning':bool(options),
                   'input':['text','image'],'contextWindow':1000000 if provider=='claude' else 272000,
                   'maxTokens':32768,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},
                   'thinkingLevelMap':{level:level if any(x['id']==level for x in options) else None
                       for level in ['off','minimal','low','medium','high','xhigh','max']}}
            if api=='anthropic-messages':model['compat']={'forceAdaptiveThinking':True,'supportsTemperature':False}
            rows.append(row);models.append(model)
            if provider==default_source and source.get('isDefault'):
                if default:raise ValueError('source catalog has multiple default models')
                default=(source,row)
    if not rows:raise ValueError('empty Pi source catalog')
    # Direct providers add picker rows from their single model list, after the fleet rows.
    for name,provider in direct_providers(runtime).items():
        for model in provider['models']:
            if model['name'] in labels or model['name'] in CANONICAL:
                raise ValueError('direct model name collides with a picker label')
            labels.add(model['name'])
            options=[{'id':level,'label':LEVEL_LABELS[level]} for level in LEVELS if model['thinkingLevelMap'][level]]
            if options:
                preferred=next((x for x in options if x['id']=='medium'),options[0]);preferred['isDefault']=True
            rows.append({'id':name+'/'+model['id'],'label':model['name'],'isDefault':False,'thinkingOptions':options})
    # Optional pinned API-key route: a second picker entry per Claude model, "<label> <suffix>", whose
    # model id carries the router prefix that pins it to the API key. Same transport, window and thinking.
    route=pi.get('claudeApiKeyRoute')
    if route is not None:
        if not isinstance(route,dict) or set(route)!={'prefix','labelSuffix'} or not re.fullmatch(r'[a-z][a-z0-9-]{0,15}',str(route['prefix'])) \
                or not re.fullmatch(r'[A-Za-z0-9]{1,16}',str(route['labelSuffix'])):
            raise ValueError('claudeApiKeyRoute needs exactly a prefix and a one-word labelSuffix')
        if 'claude' not in sources:raise ValueError('claudeApiKeyRoute requires the claude catalog source')
        for source in providers.get('claude',{}).get('models',[]):
            base=next(m for m in models if m['name']==source['label']);label=source['label']+' '+route['labelSuffix']
            if label in labels:raise ValueError('claudeApiKeyRoute label collides with a picker label')
            labels.add(label)
            model=copy.deepcopy(base);model['id']=route['prefix']+'/'+base['id'];model['name']=label
            row=copy.deepcopy(next(r for r in rows if r['label']==source['label']))
            row.update(id=namespace+'/'+model['id'],label=label,isDefault=False)
            if row.get('description'):row['description']=row['description'].rstrip('.')+'. Billed to API credits.'
            models.append(model);rows.append(row)
    if not default:
        source=providers.get(default_source,{}).get('models',[None])[0]
        if not source:raise ValueError('default provider catalog missing')
        default=(source,next(row for row in rows if row['label']==source['label']))
    source,row=default;row['isDefault']=True
    thinking=source.get('defaultThinkingOptionId') or next((x['id'] for x in source.get('thinkingOptions',[]) if x.get('isDefault')),None)
    settings=runtime.setdefault('settings',{})
    settings.update(defaultProvider=namespace,defaultModel=source.get('apiModelId',source['id']),defaultThinkingLevel=thinking or 'off')
    runtime['models']=models
    return {'provider':{'enabled':True,'command':['node','${LOADOUT_PI_ROOT}/launch.mjs'],'models':rows},
            'root':pi['root'],'runtime':runtime,'catalog_model_id':row['id']}
