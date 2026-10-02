// What the viewer says on screen: the link's status, the name of what is under the cursor and of what is
// selected, the keys.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "AetherBrainHUD.generated.h"

UCLASS()
class AETHERBRAIN_API AAetherBrainHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;
};
