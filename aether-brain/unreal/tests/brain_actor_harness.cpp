// The real AetherBrainActor.cpp and AetherScene.cpp, compiled unchanged against a stand-in for the engine (brain_stubs/FakeUE.h) and run:
// the scene it is sent, what it draws, how it keeps the link going and what it says. The stand-in is shaped after Unreal 5's signatures
// (one type for FMath::Clamp, [[nodiscard]] where the engine has it, printf-checked formats, an instanced mesh that refuses a range that
// does not fit), so a typo or a wrong argument fails here as it would in the editor. It is not Unreal: it proves the logic and the
// bookkeeping, not the engine. Run with unreal/tests/run.sh.
#include "FakeUE.h"

#include <cstdio>
#include <sstream>

#define private public
#define protected public
#include "AetherBrainActor.h"
#include "AetherBrainActor.cpp"
#include "AetherScene.cpp"
#undef private
#undef protected

static int Failures = 0;
static int Checks = 0;
#define CHECK(Cond)                                                                    \
	do                                                                                 \
	{                                                                                  \
		++Checks;                                                                      \
		if (!(Cond))                                                                   \
		{                                                                              \
			++Failures;                                                                \
			std::printf("FAIL line %d: %s\n", __LINE__, #Cond);                        \
		}                                                                              \
	} while (0)
#define CHECK_EQ(A, B)                                                                 \
	do                                                                                 \
	{                                                                                  \
		++Checks;                                                                      \
		const auto A_ = (A);                                                           \
		const auto B_ = (B);                                                           \
		if (!(A_ == B_))                                                               \
		{                                                                              \
			++Failures;                                                                \
			std::printf("FAIL line %d: %s == %s  (%lld vs %lld)\n", __LINE__, #A, #B, static_cast<long long>(A_), static_cast<long long>(B_)); \
		}                                                                              \
	} while (0)

#define CHECK_NEAR(A, B, Eps)                                                                      \
	do                                                                                             \
	{                                                                                              \
		++Checks;                                                                                  \
		const double A_ = static_cast<double>(A);                                                  \
		const double B_ = static_cast<double>(B);                                                  \
		if (!(std::fabs(A_ - B_) <= (Eps)))                                                        \
		{                                                                                          \
			++Failures;                                                                            \
			std::printf("FAIL line %d: %s = %g, expected %g\n", __LINE__, #A, A_, B_);             \
		}                                                                                          \
	} while (0)

/** /v1/graph as the desktop app sends it: `Nodes` moons without a parent, `ExtraEdges` link numbers (all 0), and more JSON after "selected". */
static std::string GraphJson(int Nodes, const std::string& Extra, int ExtraEdges = 0)
{
	std::ostringstream S;
	S << "{\"version\":3,\"vault\":\"V\",\"layout\":\"system\",\"nodes\":[";
	for (int I = 0; I < Nodes; ++I) S << (I ? "," : "") << "{\"id\":\"n" << I << "\",\"title\":\"t\",\"kind\":\"moon\",\"color\":\"#aabbcc\",\"radius\":1,\"parent\":-1}";
	S << "],\"edges\":[";
	for (int I = 0; I < ExtraEdges; ++I) S << (I ? "," : "") << "0";
	S << "],\"selected\":-1" << Extra << "}";
	return S.str();
}

/** An answer of the desktop app: its status code, its body and its tag. */
static FHttpResponsePtr Reply(int Code, const std::string& Body = std::string(), const std::string& Etag = std::string())
{
	TSharedPtr<FHttpResponseFake> R = MakeShared<FHttpResponseFake>();
	R->Code = Code;
	R->Body = Body;
	R->Bytes.assign(Body.begin(), Body.end());
	if (!Etag.empty())
	{
		R->Headers["ETag"] = Etag;
	}
	return R;
}

struct Rig
{
	UWorld World;
	APlayerController Pc;
	APlayerCameraManager Cam;
	AAetherBrainActor* Brain = nullptr;
	Rig()
	{
		Brain = new AAetherBrainActor();
		Pc.PlayerCameraManager = &Cam;
		World.Player = &Pc;
		Brain->WorldPtr = &World;
		Brain->BeginPlay();
	}
};

static FAetherGraph MakeGraph(int N, uint32 Version, const char* Vault = "V", int Total = 0)
{
	FAetherGraph G;
	G.Version = Version;
	G.Vault = FString(Vault);
	G.TotalNodes = Total;
	for (int I = 0; I < N; ++I)
	{
		FAetherNode Node;
		Node.Id = FString::Printf("n%d", I);
		Node.Title = FString::Printf("Note %d", I);
		Node.Kind = I == 0 ? EAetherKind::Sun : I % 50 == 1 ? EAetherKind::Star : I % 7 == 0 ? EAetherKind::Planet : EAetherKind::Moon;
		Node.Radius = Node.Kind == EAetherKind::Moon ? 1.f : 4.f;
		Node.Parent = I == 0 ? INDEX_NONE : (I - 1) / 3;
		G.Nodes.Add(Node);
		if (I > 0)
		{
			G.Edges.Add(Node.Parent);
			G.Edges.Add(I);
		}
	}
	return G;
}

static FAetherPositions MakePositions(const FAetherGraph& G, int Rings, float RingRadius0 = 10.f)
{
	FAetherPositions P;
	P.Version = G.Version;
	for (int I = 0; I < G.Nodes.Num(); ++I)
	{
		const double A = I * 0.37;
		P.Points.Add(FVector(std::cos(A) * (5.0 + I * 0.02), I * 0.01, std::sin(A) * (5.0 + I * 0.02)));
	}
	for (int K = 0; K < Rings; ++K)
	{
		FAetherRing R;
		R.Parent = K % std::max(1, G.Nodes.Num());
		R.Radius = RingRadius0 + static_cast<float>(K) * 0.5f;
		P.Rings.Add(R);
	}
	return P;
}

// What the engine would report if a Batch call did not fit: every ISM must have been updated with a range that fits.
static void CheckNoRejects(AAetherBrainActor* B, const char* Where)
{
	++Checks;
	if (B->Spheres->BatchRejected || B->Links->BatchRejected || B->Orbits->BatchRejected)
	{
		++Failures;
		std::printf("FAIL %s: batch update rejected (spheres %d, links %d, orbits %d)\n", Where, B->Spheres->BatchRejected, B->Links->BatchRejected, B->Orbits->BatchRejected);
	}
}

static void Redraw(AAetherBrainActor* B, int Frames = 6)
{
	for (int F = 0; F < Frames; ++F)
	{
		B->UpdateInstances(0.02f);
	}
}

int main()
{
	// ---- S1: more rings than Max Rings: capped, consistent, never rejected ----------------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(3000, 1, "Big", 250000);
		FAetherPositions P = MakePositions(G, 1500);
		B->ApplyGraph(MoveTemp(G));
		B->ApplyPositions(MoveTemp(P));
		CHECK_EQ(B->RingsDrawn, 400);
		CHECK_EQ(B->GetDrawnRingCount(), 400);
		CHECK_EQ(B->Orbits->GetInstanceCount(), 400 * 48);
		CHECK_EQ(B->OrbitSegments, 400 * 48);
		CHECK(B->HasPositions());
		Redraw(B);
		CheckNoRejects(B, "S1 redraw");
		CHECK(B->Orbits->BatchCalls >= 1);
		// the last drawn ring's last segment was written (non-degenerate), and the segment after the cap does not exist
		const FTransform& Last = B->Orbits->Instances.back();
		CHECK(Last.Scale3D.Z > 0.0);
		// status line says what is drawn
		std::printf("status: %s\n", *B->GetStatus());
		CHECK(B->GetStatus().S.find("the 3000 most important of 250000 nodes") != std::string::npos);
		CHECK(B->GetStatus().S.find("400 orbit rings") != std::string::npos);
		CHECK(B->GetStatus().S.find("2999 links") != std::string::npos || B->GetStatus().S.find("2999") != std::string::npos);
		// Max Rings changed in the details panel and the next positions frame arrives: rebuilt to the new cap, still consistent.
		B->MaxRings = 10;
		FAetherGraph G2 = MakeGraph(3000, 1);
		FAetherPositions P2 = MakePositions(G2, 1500);
		B->ApplyPositions(MoveTemp(P2));
		CHECK_EQ(B->RingsDrawn, 10);
		CHECK_EQ(B->Orbits->GetInstanceCount(), 480);
		Redraw(B);
		CheckNoRejects(B, "S1 after cap change");
		// MaxRings 0 or negative: nothing drawn, no crash
		B->MaxRings = -5;
		FAetherPositions P3 = MakePositions(G2, 20);
		B->ApplyPositions(MoveTemp(P3));
		CHECK_EQ(B->RingsDrawn, 0);
		CHECK_EQ(B->Orbits->GetInstanceCount(), 0);
		Redraw(B);
		CheckNoRejects(B, "S1 zero cap");
	}

	// ---- S2: rebuilt only when the rings changed ------------------------------------------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(200, 7);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 12));
		const int Clears = B->Orbits->ClearCalls;
		const int Adds = B->Orbits->AddCalls;
		for (int Frame = 0; Frame < 20; ++Frame)
		{
			B->ApplyPositions(MakePositions(G, 12));  // same rings every frame (10 a second)
		}
		CHECK_EQ(B->Orbits->ClearCalls, Clears);
		CHECK_EQ(B->Orbits->AddCalls, Adds);
		// one ring's radius moves by a unit: rebuilt
		FAetherPositions P = MakePositions(G, 12);
		P.Rings[5].Radius += 1.f;
		B->ApplyPositions(MoveTemp(P));
		CHECK_EQ(B->Orbits->ClearCalls, Clears + 1);
		// the radius moves by float noise only: not rebuilt
		FAetherPositions Q = MakePositions(G, 12);
		Q.Rings[5].Radius += 1.f;
		Q.Rings[5].Radius += 1e-6f;
		B->ApplyPositions(MoveTemp(Q));
		CHECK_EQ(B->Orbits->ClearCalls, Clears + 1);
		// a ring parent changes: rebuilt
		FAetherPositions S = MakePositions(G, 12);
		S.Rings[5].Radius += 1.f;
		S.Rings[3].Parent = 77;
		B->ApplyPositions(MoveTemp(S));
		CHECK_EQ(B->Orbits->ClearCalls, Clears + 2);
		// Show Orbits off: rings are dropped once, then stay dropped without churn
		B->bShowOrbits = false;
		B->ApplyPositions(MakePositions(G, 12));
		CHECK_EQ(B->RingsDrawn, 0);
		CHECK_EQ(B->Orbits->GetInstanceCount(), 0);
		const int Clears2 = B->Orbits->ClearCalls;
		B->ApplyPositions(MakePositions(G, 12));
		B->ApplyPositions(MakePositions(G, 12));
		CHECK_EQ(B->Orbits->ClearCalls, Clears2);
		B->bShowOrbits = true;
		B->ApplyPositions(MakePositions(G, 12));
		CHECK_EQ(B->RingsDrawn, 12);
		Redraw(B);
		CheckNoRejects(B, "S2");
	}

	// ---- S3: selection change (same nodes and links) keeps everything; a different node set drops the rings ---------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(300, 3);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 9));
		Redraw(B);
		const int Clears = B->Orbits->ClearCalls;
		const int SphereClears = B->Spheres->ClearCalls;
		FAetherGraph Same = MakeGraph(300, 4);
		Same.Selected = 5;
		B->ApplyGraph(MoveTemp(Same));
		CHECK_EQ(B->Orbits->ClearCalls, Clears);
		CHECK_EQ(B->Spheres->ClearCalls, SphereClears);
		CHECK_EQ(B->RingsDrawn, 9);
		CHECK_EQ(B->Rings.Num(), 9);
		CHECK_EQ(B->Orbits->GetInstanceCount(), 9 * 48);
		// positions of the new version arrive
		FAetherGraph G4 = MakeGraph(300, 4);
		B->ApplyPositions(MakePositions(G4, 9));
		Redraw(B);
		CheckNoRejects(B, "S3 same shape");

		// another vault: same count, different ids
		FAetherGraph Other = MakeGraph(300, 5);
		for (int I = 0; I < Other.Nodes.Num(); ++I)
		{
			Other.Nodes[I].Id = FString::Printf("other%d", I);
		}
		B->ApplyGraph(MoveTemp(Other));
		CHECK_EQ(B->Rings.Num(), 0);
		CHECK_EQ(B->RingsDrawn, 0);
		CHECK_EQ(B->OrbitSegments, 0);
		CHECK_EQ(B->Orbits->GetInstanceCount(), 0);
		Redraw(B);
		CheckNoRejects(B, "S3 other vault before positions");
		// stale positions of the old version are refused
		B->ApplyPositions(MakePositions(G4, 9));
		CHECK_EQ(B->RingsDrawn, 0);
		FAetherGraph O5 = MakeGraph(300, 5);
		B->ApplyPositions(MakePositions(O5, 6));
		CHECK_EQ(B->RingsDrawn, 6);
		Redraw(B);
		CheckNoRejects(B, "S3 other vault after positions");

		// fewer nodes: ring parents that no longer exist are tolerated
		FAetherGraph Small = MakeGraph(20, 6);
		B->ApplyGraph(MoveTemp(Small));
		CHECK_EQ(B->RingsDrawn, 0);
		FAetherGraph S6 = MakeGraph(20, 6);
		FAetherPositions PS = MakePositions(S6, 4);
		PS.Rings[2].Parent = 999;       // out of range: parse would have made it INDEX_NONE, but be safe
		PS.Rings[3].Parent = INDEX_NONE;
		B->ApplyPositions(MoveTemp(PS));
		Redraw(B);
		CheckNoRejects(B, "S3 bad parents");
	}

	// ---- S4: the unplaced first frame ----------------------------------------------------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(100, 2);
		B->ApplyGraph(FAetherGraph(G));
		FAetherPositions Zero;
		Zero.Version = 2;
		for (int I = 0; I < 100; ++I) Zero.Points.Add(FVector(0, 0, 0));
		Zero.Rings.Add(FAetherRing());
		B->PositionsTag = FString("etag");
		B->ApplyPositions(MoveTemp(Zero));
		CHECK(!B->HasPositions());
		CHECK(!B->ConsumeFirstPositions());
		CHECK(B->PositionsTag.IsEmpty());       // so the next poll is a full request, not a 304 on the refused frame
		CHECK_EQ(B->RingsDrawn, 0);
		B->ApplyPositions(MakePositions(G, 5));
		CHECK(B->HasPositions());
		CHECK(B->ConsumeFirstPositions());
		CHECK_EQ(B->RingsDrawn, 5);
		// one node: a single node at the origin is a real layout
		Rig R1;
		FAetherGraph One = MakeGraph(1, 9);
		R1.Brain->ApplyGraph(FAetherGraph(One));
		FAetherPositions P1;
		P1.Version = 9;
		P1.Points.Add(FVector(0, 0, 0));
		R1.Brain->ApplyPositions(MoveTemp(P1));
		CHECK(R1.Brain->HasPositions());
	}

	// ---- S5: nothing is drawn thinner than its minimum angle, and a sun stays bigger than a moon ------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(40, 11);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 3));
		B->Current = B->Target;
		// far away: 3 km
		R.Cam.Location = FVector(300000.0, 0, 0);
		Redraw(B);
		const auto RankOfNode = [&G](int I) { const EAetherKind K = G.Nodes[I].Kind; return K == EAetherKind::Sun ? 0 : K == EAetherKind::Star ? 1 : K == EAetherKind::Planet ? 2 : 3; };
		const auto Angle = [&](int I) { return B->Spheres->Instances[static_cast<size_t>(I)].Scale3D.X * 50.0 / FVector::Dist(B->Current[I], R.Cam.Location); };
		for (int I = 0; I < 40; ++I)
		{
			const double Dist = FVector::Dist(B->Current[I], R.Cam.Location);
			const double Drawn = B->Spheres->Instances[static_cast<size_t>(I)].Scale3D.X * 50.0;
			CHECK(Drawn >= Dist * AetherView::MinAngleOfRank(RankOfNode(I)) * 0.999);
			CHECK(Drawn >= static_cast<double>(B->NodeRadius(I)) * 0.999);
		}
		// By rank: node 0 is the sun, 1 a star, 7 a planet, 2 a moon.
		CHECK(Angle(0) > Angle(1));
		CHECK(Angle(1) > Angle(7));
		CHECK(Angle(7) > Angle(2));
		// Hover and selection grow what is drawn, after the minimum (not inside it).
		const double Moon = Angle(2);
		B->Selected = 2;
		B->Hovered = 3;
		Redraw(B);
		CHECK_NEAR(Angle(2), Moon * 1.35, Moon * 0.01);
		CHECK_NEAR(Angle(3), Angle(4) * 1.15, Angle(4) * 0.01);
		B->Selected = INDEX_NONE;
		B->Hovered = INDEX_NONE;
		Redraw(B);
		// The threads: links and orbit pieces are at least a thread's minimum across.
		for (int E = 0; E < B->LinkCount; ++E)
		{
			const FVector Mid = (B->Current[G.Edges[E * 2]] + B->Current[G.Edges[E * 2 + 1]]) * 0.5;
			CHECK(B->Links->Instances[static_cast<size_t>(E)].Scale3D.X * 50.0 >= FVector::Dist(Mid, R.Cam.Location) * AetherView::kMinThreadAngle * 0.999);
		}
		// close: true size
		R.Cam.Location = B->Current[5] + FVector(10, 0, 0);
		Redraw(B);
		CHECK(std::fabs(B->Spheres->Instances[5].Scale3D.X * 50.0 - static_cast<double>(B->NodeRadius(5))) < 1e-6);
		// no player: true size, no crash
		R.World.Player = nullptr;
		Redraw(B);
		CHECK(std::fabs(B->Spheres->Instances[5].Scale3D.X * 50.0 - static_cast<double>(B->NodeRadius(5))) < 1e-6);
		CheckNoRejects(B, "S5");
		// camera manager null
		R.World.Player = &R.Pc;
		R.Pc.PlayerCameraManager = nullptr;
		Redraw(B);
		CheckNoRejects(B, "S5 no camera manager");
	}

	// ---- S6: pacing: not every frame, the first one at once, and the scratch array does not grow after the first redraw ------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(5000, 21);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 300));
		const int Before = B->Spheres->BatchCalls;
		B->UpdateInstances(0.010f);
		CHECK_EQ(B->Spheres->BatchCalls, Before + 1);   // a new scene is drawn at once, not up to a redraw gap later
		B->UpdateInstances(0.010f);
		B->UpdateInstances(0.010f);
		B->UpdateInstances(0.010f);
		CHECK_EQ(B->Spheres->BatchCalls, Before + 1);   // 30 ms < 33.3 ms
		B->UpdateInstances(0.010f);
		CHECK_EQ(B->Spheres->BatchCalls, Before + 2);
		const size_t Cap = B->Scratch.V.capacity();
		const void* Data = B->Scratch.V.data();
		for (int F = 0; F < 30; ++F) B->UpdateInstances(0.04f);
		CHECK(B->Scratch.V.capacity() >= Cap);
		CHECK(B->Scratch.V.data() == Data);              // no reallocation across frames
		CheckNoRejects(B, "S6");
		CHECK(B->RedrawGap >= AetherView::kMinUpdateGap - 1e-12 && B->RedrawGap <= AetherView::kMaxUpdateGap + 1e-12);
		// A scene that arrives in the middle of a gap is drawn the next frame, not when the gap is over.
		B->RedrawGap = 0.5;
		B->UpdateInstances(0.001f);
		const int Calls = B->Spheres->BatchCalls;
		FAetherGraph Next = MakeGraph(5000, 22);
		Next.Selected = 4;
		B->ApplyGraph(MoveTemp(Next));
		B->UpdateInstances(0.001f);
		CHECK_EQ(B->Spheres->BatchCalls, Calls + 1);
	}

	// ---- S7: ParseGraph / ParsePositions backstops and the limits field ------------------------------------------------------
	{
		FAetherGraph G;
		bool bTooBig = true;
		auto Json = [](int Nodes, const std::string& Extra, int ExtraEdges = 0) { return FString(GraphJson(Nodes, Extra, ExtraEdges)); };
		CHECK(AetherScene::ParseGraph(Json(3, ""), G, &bTooBig));
		CHECK(!bTooBig);
		CHECK_EQ(G.TotalNodes, 0);
		CHECK_EQ(G.TotalLinks, 0);
		CHECK(AetherScene::ParseGraph(Json(3, ",\"limits\":{\"ofNodes\":250000,\"ofLinks\":900000}"), G));
		CHECK_EQ(G.TotalNodes, 250000);
		CHECK_EQ(G.TotalLinks, 900000);
		CHECK(AetherScene::ParseGraph(Json(3, ",\"limits\":{\"ofNodes\":1e15,\"ofLinks\":-4}"), G));
		CHECK_EQ(G.TotalNodes, 2000000000);
		CHECK_EQ(G.TotalLinks, 0);
		CHECK(AetherScene::ParseGraph(Json(3, ",\"limits\":5"), G));         // not an object: ignored
		CHECK_EQ(G.TotalNodes, 0);
		CHECK(AetherScene::ParseGraph(Json(3, ",\"limits\":{}"), G));
		CHECK_EQ(G.TotalNodes, 0);
		CHECK(AetherScene::ParseGraph(Json(3, ",\"limits\":null"), G));
		CHECK(AetherScene::ParseGraph(Json(50000, ""), G));
		CHECK_EQ(G.Nodes.Num(), 50000);
		// Too many nodes: refused, and said to be too many (not broken), the old graph untouched.
		FAetherGraph Keep;
		Keep.Version = 77;
		bTooBig = false;
		CHECK(!AetherScene::ParseGraph(Json(50001, ""), Keep, &bTooBig));
		CHECK(bTooBig);
		CHECK_EQ(Keep.Version, 77u);
		// Broken is not too big.
		bTooBig = true;
		CHECK(!AetherScene::ParseGraph(FString("{\"version\":3,\"nodes\":[],\"edges\":[0]}"), Keep, &bTooBig));
		CHECK(!bTooBig);
		CHECK(!AetherScene::ParseGraph(FString("not json"), Keep, &bTooBig));
		CHECK(!bTooBig);
		// More links than a viewer draws: the first of them are drawn, and the scene still is (an older Aether Brain sends every link).
		CHECK(AetherScene::ParseGraph(Json(3, "", 100000), G));
		CHECK_EQ(G.Edges.Num(), 100000);
		CHECK(AetherScene::ParseGraph(Json(3, "", 100002), G, &bTooBig));
		CHECK(!bTooBig);
		CHECK_EQ(G.Edges.Num(), 100000);
		CHECK_EQ(G.Nodes.Num(), 3);
		// An odd count of link numbers is broken, however long.
		CHECK(!AetherScene::ParseGraph(Json(3, "", 5), G));
		// A link to a node that is not there is broken.
		CHECK(!AetherScene::ParseGraph(FString("{\"version\":3,\"nodes\":[{\"id\":\"a\"}],\"edges\":[0,5]}"), G));

		auto Bytes = [](uint32 Nodes, uint32 Rings, uint32 Version = 3) {
			TArray<uint8> B;
			auto Put = [&B](uint32 V) { for (int K = 0; K < 4; ++K) B.Add(static_cast<uint8>((V >> (8 * K)) & 0xff)); };
			Put(0x31504541u); Put(Version); Put(Nodes); Put(Rings);
			for (uint32 I = 0; I < Nodes * 3 + Rings * 6; ++I) Put(0);
			return B;
		};
		FAetherPositions P;
		CHECK(AetherScene::ParsePositions(Bytes(4, 2), P));
		CHECK_EQ(P.Rings.Num(), 2);
		CHECK(AetherScene::ParsePositions(Bytes(50000, 2000), P));
		CHECK_EQ(P.Rings.Num(), 2000);
		// More rings than a viewer keeps (an older Aether Brain sends every one): the frame is as long as it says, the first are kept.
		CHECK(AetherScene::ParsePositions(Bytes(5, 3001), P));
		CHECK_EQ(P.Rings.Num(), 2000);
		CHECK_EQ(P.Points.Num(), 5);
		CHECK(!AetherScene::ParsePositions(Bytes(50001, 0), P));
		{
			// A frame that is not as long as it says is refused, however it is cut.
			TArray<uint8> Short = Bytes(5, 3001);
			Short.V.pop_back();
			CHECK(!AetherScene::ParsePositions(Short, P));
			// a claimed count far above the cap with a short body is refused before any allocation
			TArray<uint8> Liar;
			auto Put = [&Liar](uint32 V) { for (int K = 0; K < 4; ++K) Liar.Add(static_cast<uint8>((V >> (8 * K)) & 0xff)); };
			Put(0x31504541u); Put(1); Put(0xffffffffu); Put(0xffffffffu);
			CHECK(!AetherScene::ParsePositions(Liar, P));
		}
		// The rings kept are the first ones, with their parents and radii.
		{
			TArray<uint8> Frame;
			auto Put = [&Frame](uint32 V) { for (int K = 0; K < 4; ++K) Frame.Add(static_cast<uint8>((V >> (8 * K)) & 0xff)); };
			auto PutF = [&Put](float F) { uint32 V; std::memcpy(&V, &F, 4); Put(V); };
			Put(0x31504541u); Put(9); Put(2); Put(2);
			for (int I = 0; I < 6; ++I) PutF(static_cast<float>(I));
			for (int K = 0; K < 2; ++K) { PutF(static_cast<float>(K)); PutF(10.f + static_cast<float>(K)); PutF(0.f); PutF(0.f); PutF(0.f); PutF(1.f); }
			FAetherPositions Q;
			CHECK(AetherScene::ParsePositions(Frame, Q));
			CHECK_EQ(Q.Version, 9u);
			CHECK_EQ(Q.Rings.Num(), 2);
			CHECK_EQ(Q.Rings[1].Parent, 1);
			CHECK_NEAR(Q.Rings[1].Radius, 11.0, 1e-6);
			CHECK_NEAR(Q.Points[1].X, 3.0, 1e-6);
		}
	}

	// ---- S8: the status line: what is true now, and what refusing a scene says ---------------------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		B->Conn.Url = FString("http://127.0.0.1:1");
		B->Conn.Token = FString("t");
		const auto Has = [&B](const char* Text) { return B->GetStatus().S.find(Text) != std::string::npos; };
		// A graph with its places: the line says what is drawn.
		FAetherGraph G = MakeGraph(50, 3, "Vault");
		B->OnGraph(nullptr, Reply(200, GraphJson(50, ""), "g1"), true);
		CHECK_EQ(B->Graph.Nodes.Num(), 50);
		CHECK(Has("50 nodes"));
		// The layout is not worked out yet (a 503 for the places): it says so, it does not claim a vault is missing.
		CHECK(!B->CheckAnswer(Reply(503), true));
		CHECK(Has("working out where everything goes"));
		CHECK(B->bLive);
		// The next good answer writes what is drawn again (a 304 changes nothing else).
		CHECK(B->CheckAnswer(Reply(304), true));
		CHECK(Has("live from Aether Brain"));
		CHECK(!B->bStatusStale);
		// Not reachable, then reachable again: the same.
		CHECK(!B->CheckAnswer(nullptr, false));
		CHECK(Has("Can't reach Aether Brain"));
		CHECK(!B->bLive);
		B->Conn.Url = FString("http://127.0.0.1:1");
		B->Conn.Token = FString("t");
		CHECK(B->CheckAnswer(Reply(304), true));
		CHECK(Has("live from Aether Brain"));
		// No graph at all yet: the wait is about a vault.
		Rig R2;
		CHECK(!R2.Brain->CheckAnswer(Reply(503), true));
		CHECK(R2.Brain->GetStatus().S.find("Waiting for Aether Brain to show a vault") != std::string::npos);

		// A scene far bigger than a viewer takes is not read at all, and says whose update is needed.
		Rig R3;
		AAetherBrainActor* C = R3.Brain;
		C->OnGraph(nullptr, Reply(200, GraphJson(10, ""), "g1"), true);
		CHECK_EQ(C->Graph.Nodes.Num(), 10);
		FHttpResponsePtr Huge = Reply(200, "this is never parsed", "g2");
		Huge->Bytes.assign(static_cast<size_t>(AetherScene::MaxGraphBytes) + 1, static_cast<uint8>('x'));
		C->OnGraph(nullptr, Huge, true);
		CHECK(C->GetStatus().S.find("more of the brain than this viewer can draw") != std::string::npos);
		CHECK_EQ(C->Graph.Nodes.Num(), 10);                   // the scene before is still drawn
		CHECK(C->GraphTag == FString("g2"));                  // and this one is not fetched again every half second
		// Too many nodes in a smaller document: the same.
		C->OnGraph(nullptr, Reply(200, GraphJson(50001, ""), "g3"), true);
		CHECK(C->GetStatus().S.find("more of the brain than this viewer can draw") != std::string::npos);
		CHECK(C->GraphTag == FString("g3"));
		// A positions answer in between does not write over it.
		CHECK(C->CheckAnswer(Reply(304), true));
		CHECK(C->GetStatus().S.find("more of the brain than this viewer can draw") != std::string::npos);
		// Broken: another thing to say.
		C->OnGraph(nullptr, Reply(200, "{\"version\":", "g4"), true);
		CHECK(C->GetStatus().S.find("can't read") != std::string::npos);
		CHECK(C->GraphTag == FString("g4"));
		// And the next good scene is drawn and described.
		C->OnGraph(nullptr, Reply(200, GraphJson(12, ""), "g5"), true);
		CHECK_EQ(C->Graph.Nodes.Num(), 12);
		CHECK(C->GetStatus().S.find("12 nodes") != std::string::npos);
	}

	// ---- S9: the first places, a flight to the brain's selection, and what a new node starts from -------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		B->Conn.Url = FString("http://127.0.0.1:1");
		B->Conn.Token = FString("t");
		FAetherGraph G = MakeGraph(40, 1);
		B->ApplyGraph(FAetherGraph(G));
		// Until the layout says where things are nothing is shown (all of it would be one clump at the origin).
		CHECK(!B->Spheres->bVisible && !B->Links->bVisible && !B->Orbits->bVisible);
		B->ApplyPositions(MakePositions(G, 4));
		CHECK(B->Spheres->bVisible && B->Links->bVisible && B->Orbits->bVisible);
		CHECK(B->ConsumeFirstPositions());

		// A new node starts where the nearest folder of it that was drawn before is, not at the origin.
		FAetherGraph G2 = MakeGraph(40, 2);
		for (int K = 0; K < 3; ++K)
		{
			FAetherNode N;
			N.Id = FString::Printf("new%d", K);
			N.Title = FString("New");
			N.Kind = EAetherKind::Moon;
			N.Parent = K == 0 ? 5 : 40 + K - 1;       // 5 was drawn before; the other two are new, one below the other
			G2.Nodes.Add(N);
			G2.Edges.Add(N.Parent);
			G2.Edges.Add(40 + K);
		}
		const FVector Five = B->Current[5];
		CHECK(Five.Size() > 1.0);
		B->ApplyGraph(MoveTemp(G2));
		for (int K = 0; K < 3; ++K)
		{
			CHECK(std::fabs(B->Current[40 + K].X - Five.X) < 1e-9 && std::fabs(B->Current[40 + K].Y - Five.Y) < 1e-9 && std::fabs(B->Current[40 + K].Z - Five.Z) < 1e-9);
		}
		CHECK(B->Spheres->bVisible);                    // not hidden again for a new node set once there have been places

		// The desktop app selects a note whose graph has other nodes: the flight waits for the places of that graph.
		FAetherGraph Other = MakeGraph(30, 3);
		for (int I = 0; I < Other.Nodes.Num(); ++I) Other.Nodes[I].Id = FString::Printf("x%d", I);
		Other.Selected = 4;
		B->ApplyGraph(FAetherGraph(Other));
		int32 Where = INDEX_NONE;
		CHECK(!B->ConsumeBrainSelection(Where));
		CHECK(!B->ConsumeBrainSelection(Where));        // asked again: still waiting, not forgotten
		B->ApplyPositions(MakePositions(Other, 2));
		CHECK(B->ConsumeBrainSelection(Where));
		CHECK_EQ(Where, 4);
		CHECK(!B->ConsumeBrainSelection(Where));

		// The viewer clicks a node: when the next scene has it at another number, that is not a new selection of the desktop app.
		B->SelectNode(9, false);
		CHECK_EQ(B->Selected, 9);
		FAetherGraph Shifted;
		Shifted.Version = 4;
		Shifted.Vault = Other.Vault;
		{
			FAetherNode Extra;
			Extra.Id = FString("extra");
			Extra.Title = FString("Extra");
			Shifted.Nodes.Add(Extra);
			for (const FAetherNode& N : Other.Nodes)
			{
				FAetherNode Copy = N;
				Copy.Parent = N.Parent >= 0 ? N.Parent + 1 : INDEX_NONE;
				Shifted.Nodes.Add(Copy);
			}
			for (int32 E : Other.Edges) Shifted.Edges.Add(E + 1);
			Shifted.Selected = 9 + 1;                  // the same note, one number further
		}
		B->ApplyGraph(MoveTemp(Shifted));
		B->ApplyPositions(MakePositions(B->Graph, 2));
		CHECK(!B->ConsumeBrainSelection(Where));
		CHECK_EQ(B->Selected, 10);                      // still the note that was clicked, under its new number
		// The desktop app selects another one: that is.
		FAetherGraph Next = B->Graph;
		Next.Version = 5;
		Next.Selected = 3;
		B->ApplyGraph(MoveTemp(Next));
		B->ApplyPositions(MakePositions(B->Graph, 2));
		CHECK(B->ConsumeBrainSelection(Where));
		CHECK_EQ(Where, 3);
		// The same nodes and links with another selection keep what is drawn.
		const int SphereClears = B->Spheres->ClearCalls;
		FAetherGraph Again = B->Graph;
		Again.Version = 6;
		Again.Selected = 8;
		B->ApplyGraph(MoveTemp(Again));
		CHECK_EQ(B->Spheres->ClearCalls, SphereClears);
		CHECK(B->bPositionsCurrent);                     // the places held are still those of these nodes
		CHECK(B->ConsumeBrainSelection(Where));
		CHECK_EQ(Where, 8);
	}

	// ---- S10: a second vault is not drawn as a clump either -----------------------------------------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(30, 1);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 2));
		CHECK(B->HasPositions());
		FAetherGraph Other = MakeGraph(30, 2);
		for (int I = 0; I < Other.Nodes.Num(); ++I) Other.Nodes[I].Id = FString::Printf("v2n%d", I);
		B->ApplyGraph(FAetherGraph(Other));
		FAetherPositions Zero;
		Zero.Version = 2;
		for (int I = 0; I < 30; ++I) Zero.Points.Add(FVector(0, 0, 0));
		B->PositionsTag = FString("etag");
		const FVector Before = B->Target[5];
		B->ApplyPositions(MoveTemp(Zero));
		CHECK(B->PositionsTag.IsEmpty());                // refused, so the next poll is a full request
		CHECK(!B->bPositionsCurrent);
		CHECK_EQ(B->Target[5].X, Before.X);
		B->ApplyPositions(MakePositions(Other, 2));
		CHECK(B->bPositionsCurrent);
		CHECK(B->Target[5].Size() > 0.0);
	}

	// ---- S11: pointing: the nearer body that is clearly under the ray, a tiny far one within a few pixels ------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(40, 1);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 1));
		B->Current = B->Target;
		for (int I = 0; I < 40; ++I) B->Current[I] = FVector(0.0, 5000.0 + 400.0 * I, 5000.0);   // out of the way
		const FVector Origin(0, 0, 0);
		const FVector Ahead(1, 0, 0);
		// moons 3 and 4 (20 cm): one 10 m away, one 20 m, the ray through both centres: the nearer.
		B->Current[3] = FVector(1000, 0, 0);
		B->Current[4] = FVector(2000, 0, 0);
		CHECK_EQ(B->Pick(Origin, Ahead), 3);
		// 30 cm off the farther one's centre (beyond its 20 cm) and well off the nearer one: nothing.
		B->Current[3] = FVector(1000, 900, 0);
		B->Current[4] = FVector(2000, 30, 0);
		CHECK_EQ(B->Pick(Origin, Ahead), INDEX_NONE);
		// Seen from 3 km the same moon is tiny, but a ray a few pixels off still picks it.
		B->Current[4] = FVector(300000, 900, 0);
		CHECK_EQ(B->Pick(Origin, Ahead), 4);
		B->Current[4] = FVector(300000, 1500, 0);
		CHECK_EQ(B->Pick(Origin, Ahead), INDEX_NONE);
		// A ray that only grazes a big nearer body (the sun, node 0, 80 cm across: the ray is 85 cm off, within its reach but not well
		// inside it) and goes through the centre of a farther one: the one clearly under the ray.
		B->Current[0] = FVector(5000, 85, 0);
		B->Current[3] = FVector(9000, 0, 0);
		CHECK_EQ(B->Pick(Origin, Ahead), 3);
		// Behind the camera is never hit.
		CHECK_EQ(B->Pick(Origin, FVector(-1, 0, 0)), INDEX_NONE);
	}

	// ---- S12: names stay readable from afar, and are not remade for every step of the camera -----------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(60, 1);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 2));
		B->Current = B->Target;
		CHECK(B->LabelNodes.Num() > 3);
		UTextRenderComponent* Label = B->Labels[0];
		R.Cam.Location = B->Current[B->LabelNodes[0]] + FVector(200, 0, 0);
		B->UpdateLabels();
		CHECK(Label->WorldSize <= 260.f);
		CHECK(Label->WorldSize >= 24.f);
		const float Near = Label->WorldSize;
		// 3 km away: tall enough to read.
		R.Cam.Location = B->Current[B->LabelNodes[0]] + FVector(300000, 0, 0);
		B->UpdateLabels();
		CHECK(Label->WorldSize > 1500.f);
		CHECK(Label->WorldSize > Near * 5.f);
		// A small step of the camera is not a new size; a big one is.
		const int Calls = Label->SizeCalls;
		R.Cam.Location = B->Current[B->LabelNodes[0]] + FVector(310000, 0, 0);
		B->UpdateLabels();
		CHECK_EQ(Label->SizeCalls, Calls);
		R.Cam.Location = B->Current[B->LabelNodes[0]] + FVector(600000, 0, 0);
		B->UpdateLabels();
		CHECK_EQ(Label->SizeCalls, Calls + 1);
		// Back close: the name comes back to its own size.
		R.Cam.Location = B->Current[B->LabelNodes[0]] + FVector(200, 0, 0);
		B->UpdateLabels();
		CHECK_NEAR(Label->WorldSize, Near, 0.01);
	}

	// ---- S13: a redraw that is slow in the engine, not only here, makes the next ones rarer -----------------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(500, 1);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 5));
		B->UpdateInstances(0.02f);                       // the first redraw
		CHECK(B->bMeasureNext);
		B->UpdateInstances(0.25f);                       // the frame after it took a quarter of a second
		CHECK(!B->bMeasureNext);
		CHECK_NEAR(B->RedrawGap, AetherView::kMaxUpdateGap, 1e-9);
		// It redraws when the gap has passed, and once the frames are fast again so is the redraw.
		B->UpdateInstances(0.6f);
		CHECK(B->bMeasureNext);
		B->UpdateInstances(0.016f);
		CHECK(B->RedrawGap < 0.2);
	}

	// ---- S14: a flight goes to where a node will be, and the home view frames where the brain will be ---------------------------------
	{
		Rig R;
		AAetherBrainActor* B = R.Brain;
		FAetherGraph G = MakeGraph(20, 1);
		B->ApplyGraph(FAetherGraph(G));
		B->ApplyPositions(MakePositions(G, 1));
		B->Current[3] = FVector(-9999, 0, 0);            // on its way
		CHECK_EQ(B->NodeTarget(3).X, B->Target[3].X);
		CHECK(B->NodeLocation(3).X < -9000.0);
		CHECK_EQ(B->NodeTarget(-1).X, 0.0);
		FVector Centre;
		float Radius = 0.f;
		CHECK(B->GetBounds(Centre, Radius));
		FBox Box(ForceInit);
		for (const FVector& P : B->Target) Box += P;
		CHECK_NEAR(Centre.X, Box.GetCenter().X, 1e-6);
		CHECK(Radius < 5000.f);                          // not stretched by the node that is still on its way
	}

	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
