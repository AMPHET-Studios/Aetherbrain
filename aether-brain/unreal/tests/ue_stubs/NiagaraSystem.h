// A stand-in for a Niagara system asset: the layer only loads it and hands it to a component.
#pragma once
#include "UEStubs.h"

class UNiagaraSystem : public UObject
{
public:
	const char* Label = "";
};
