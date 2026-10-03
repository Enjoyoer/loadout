"""Derive Pi runtime models and picker rows from the existing fleet catalog."""
import copy

CANONICAL = {'Opus','Sonnet','Fable','Astra','Sol','Luna','Web Extra','Web Pro'}


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
